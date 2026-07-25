import { NonRetriableError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake ky with mocks. FakeHTTPError mirrors ky's HTTPError shape (instanceof +
// response.status/headers/json) so the executor's Sheets error mapping (via
// toSheetsError) is exercised.
const { kyGetMock, kyPostMock, FakeHTTPError } = vi.hoisted(() => {
  class FakeHTTPError extends Error {
    response: {
      status: number;
      headers: Headers;
      json: () => Promise<unknown>;
    };

    constructor(
      status: number,
      body: unknown = {},
      headers: Record<string, string> = {},
    ) {
      super(`Request failed with status ${status}`);
      this.response = {
        status,
        headers: new Headers(headers),
        json: async () => body,
      };
    }
  }
  return { kyGetMock: vi.fn(), kyPostMock: vi.fn(), FakeHTTPError };
});
// Writes go through `sheetsWrite` and reads through the shared `http` client, both
// of which are `ky.create(...)` — so the mock answers `create` with the same fake
// instance, and `kyPostMock` still observes every write.
vi.mock("ky", () => {
  const instance = { get: kyGetMock, post: kyPostMock };
  return {
    default: { ...instance, create: () => instance },
    HTTPError: FakeHTTPError,
    TimeoutError: class TimeoutError extends Error {},
  };
});

const { refreshTokenMock } = vi.hoisted(() => ({ refreshTokenMock: vi.fn() }));
vi.mock("@/lib/google-token", () => ({
  refreshGoogleTokenIfNeeded: refreshTokenMock,
}));

// Make `.status(payload)` return the payload so `publish` receives it verbatim.
vi.mock("@/inngest/channels/node-status", () => ({
  nodeStatusChannel: () => ({ status: (payload: unknown) => payload }),
}));

import {
  type FanOutOutcome,
  isFanOut,
  isRouted,
  type NodeExecutorParams,
} from "@/features/executions/types";
import { encodeCustomFeatureToken } from "@/lib/custom-feature-token";
import { googleSheetsActionExecutor } from "./executor";

// Records the step names the executor checkpoints under. Which work lands in
// WHICH step is a correctness property here (an under-group append splits its
// insert from its write so an Inngest retry of the write replays the memoized
// insert instead of opening a second row), so the tests can assert on it.
let stepNames: string[];
const step = {
  run: async (name: string, fn: () => unknown) => {
    stepNames.push(name);
    return fn();
  },
} as unknown as NodeExecutorParams["step"];

let publishedStatuses: string[];
const publish = (async (msg: { status: string }) => {
  publishedStatuses.push(msg.status);
}) as unknown as NodeExecutorParams["publish"];

// readSheetTable does `ky.get(url).json<T>()` — return the values payload.
/**
 * Tab titles the fixtures in this file use. `mockRead` answers getSheetGrid with
 * all of them, so a read test needn't restate which tab it is on — every
 * row-reading action now looks the tab's merges up to tell headings from data,
 * and `getSheetGrid` throws when the title is absent.
 */
const FIXTURE_TABS = ["Ledger", "Master", "Grouped", "Jobs", "Sheet1"];

function mockRead(values: unknown[][], merges: unknown[] = []) {
  kyGetMock.mockImplementation((url: string) => ({
    json: async () =>
      url.includes("/values/")
        ? { values }
        : {
            sheets: FIXTURE_TABS.map((title, i) => ({
              properties: {
                sheetId: i,
                title,
                gridProperties: { rowCount: 1000 },
              },
              merges,
            })),
          },
  }));
}

// As mockRead, but also answers getSheetGrid's metadata GET (same ky.get, a
// different URL). An under-group append needs both: the tab's numeric sheetId to
// address it in a structural batchUpdate, and its grid HEIGHT to know whether
// the row it wants to insert into even exists yet.
function mockReadWithGrid(
  values: unknown[][],
  {
    sheetId = 77,
    rowCount = 1000,
    title = "Grouped",
  }: { sheetId?: number; rowCount?: number; title?: string } = {},
) {
  kyGetMock.mockImplementation((url: string) => ({
    json: async () =>
      url.includes("/values/")
        ? { values }
        : {
            sheets: [
              {
                properties: {
                  sheetId,
                  title,
                  gridProperties: { rowCount },
                },
              },
            ],
          },
  }));
}

/** The single ValueRange of an absolute-range write (values:batchUpdate). */
function writtenRange(index: number) {
  const body = postBody(index);
  const [first] = (body.data ?? []) as Array<{
    range: string;
    values: unknown[][];
  }>;
  return { url: body.url, range: first?.range, values: first?.values };
}

/**
 * The body of the Nth ky.post, with its URL. The Sheets actions post to four
 * different endpoints (:append, values:batchUpdate, structural batchUpdate), so
 * every payload key any of them carries is optional here.
 */
type PostJson = {
  requests?: unknown[];
  valueInputOption?: string;
  data?: unknown[];
  values?: unknown[];
};
function postBody(index: number) {
  const [url, options] = kyPostMock.mock.calls[index] as [
    string,
    { json: PostJson; searchParams?: Record<string, string> },
  ];
  return { url, searchParams: options.searchParams, ...options.json };
}

type SheetsResult = Record<
  string,
  {
    action: string;
    appendedRows?: number;
    blankRowAbove?: boolean;
    row?: string[];
    rowByHeader?: Record<string, string>;
    matchCount?: number;
    columns?: string[];
    rows?: Record<string, string>[];
    columnValues?: Record<string, string>;
    firstRow?: Record<string, string>;
    matched?: boolean;
    rowIndex?: number;
    previousRow?: Record<string, string>;
    insertedUnderGroup?: boolean;
    anchorRow?: Record<string, string>;
    insertedRows?: Record<string, string>[];
    // append_heading
    headingText?: string;
    mergedColumns?: number;
    // find_heading / update_heading / color_heading
    headings?: string[];
    headingRowIndexes?: number[];
    firstHeading?: string;
    headingsOnTab?: number;
    nearMisses?: number;
    actedCount?: number;
    previousHeading?: string;
    restyled?: boolean;
    color?: string;
    // color_rows
    rowIndexes?: number[];
    colors?: string[];
    coloredCount?: number;
  }
>;

const run = (
  data: Record<string, unknown>,
  context: Record<string, unknown> = {},
) =>
  googleSheetsActionExecutor({
    data,
    nodeId: "n1",
    outputKey: "GOOGLE_SHEETS_ACTION_1",
    userId: "u1",
    context,
    step,
    publish,
  } as unknown as NodeExecutorParams) as Promise<SheetsResult>;

// find_rows and update_row now BRANCH: they return a routed outcome (Found /
// Not-found, Updated / No-match) whose context holds the same output shape the
// tests assert on, or a fan-out outcome in "each" mode. `ctx` unwraps either
// back to the plain result the assertions expect; `outputs` reads the active
// handle set off a routed outcome.
function ctx(outcome: unknown): SheetsResult {
  return (
    isRouted(outcome) || isFanOut(outcome)
      ? (outcome as { context: unknown }).context
      : outcome
  ) as SheetsResult;
}
function outputs(outcome: unknown): string[] {
  if (!isRouted(outcome)) throw new Error("expected a routed outcome");
  return outcome.outputs;
}

const serialToken = encodeCustomFeatureToken("serialNumber", {
  start: 1,
  pad: 4,
});

beforeEach(() => {
  vi.clearAllMocks();
  publishedStatuses = [];
  stepNames = [];
  refreshTokenMock.mockResolvedValue("token-123");
  kyPostMock.mockResolvedValue({});
});

describe("googleSheetsActionExecutor — append with mappings", () => {
  it("writes the row to its ABSOLUTE range, never :append", async () => {
    mockReadWithGrid(
      [
        ["Job No.", "Name"],
        ["0001", "X"],
      ],
      { title: "Master" },
    );

    const result = await run(
      {
        action: "append_row",
        spreadsheetId: "sheet1",
        sheetName: "Master",
        columnMappings: {
          "Job No.": serialToken,
          Name: "@<telegram.from.firstName>@",
        },
      },
      { telegram: { from: { firstName: "Ada" } } },
    );

    // ONE write, to a fixed A1 range. `:append` picks its own destination by
    // "finding a table", which mis-anchors the column and duplicates on retry.
    expect(kyPostMock).toHaveBeenCalledOnce();
    const w = writtenRange(0);
    expect(w.url).toContain("values:batchUpdate");
    expect(w.url).not.toContain(":append");
    // Header row + 1 data row ⇒ the first free row is 3.
    expect(w.range).toBe("'Master'!A3:ZZ3");
    expect(w.values).toEqual([["'0002", "Ada"]]);

    // append_row does NOT branch — it returns a plain context, not a routed
    // outcome (only find_rows / update_row gained outputs).
    expect(isRouted(result)).toBe(false);
    expect(isFanOut(result)).toBe(false);
    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.appendedRows).toBe(1);
    // The row number is now chosen by us, so it is exact rather than a guess.
    expect(out.rowIndex).toBe(3);
    // serialAsText → '0002 written; rowByHeader strips the apostrophe + dot.
    expect(out.row).toEqual(["'0002", "Ada"]);
    expect(out.rowByHeader).toEqual({ "Job No": "0002", Name: "Ada" });
    expect(publishedStatuses).toContain("success");
  });

  it("writes a BLANK row when no column is mapped (every cell empty)", async () => {
    mockReadWithGrid(
      [
        ["Job No.", "Name"],
        ["0001", "X"],
      ],
      { title: "Master" },
    );

    const result = await run({
      action: "append_row",
      spreadsheetId: "s",
      sheetName: "Master",
      // No columnMappings at all — a deliberately blank row.
    });

    // Two writes: the (empty) values, then a repaint of that blank row to white
    // so it can't show the sheet's alternating-row banding.
    expect(kyPostMock).toHaveBeenCalledTimes(2);
    const w = writtenRange(0);
    expect(w.range).toBe("'Master'!A3:ZZ3");
    expect(w.values).toEqual([["", ""]]);

    // Row 3 (grid row 2) painted solid white across the 2-column header band.
    const whiten = postBody(1);
    expect(whiten.url).toContain(":batchUpdate");
    expect(whiten.url).not.toContain("values:batchUpdate");
    expect(whiten.requests).toEqual([
      {
        repeatCell: {
          range: {
            sheetId: 77,
            startRowIndex: 2,
            endRowIndex: 3,
            startColumnIndex: 0,
            endColumnIndex: 2,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
          fields: "userEnteredFormat.backgroundColor",
        },
      },
    ]);

    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.appendedRows).toBe(1);
    expect(out.rowByHeader).toEqual({ "Job No": "", Name: "" });
    expect(publishedStatuses).toContain("success");
  });

  it("does NOT whiten a MAPPED row whose values render empty (intent, not content)", async () => {
    mockReadWithGrid(
      [
        ["Job No.", "Name"],
        ["0001", "X"],
      ],
      { title: "Master" },
    );

    // The node maps a column, so it is a DATA row by intent — even though the
    // template resolves to "" this run (no `who` in context). Whitening is keyed
    // on config, not the rendered result, so the row keeps the sheet's banding
    // rather than being forced white just because its data came out empty.
    const result = await run({
      action: "append_row",
      spreadsheetId: "s",
      sheetName: "Master",
      columnMappings: { Name: "@<who>@" },
    });

    // Just the value write — no whitening batchUpdate.
    expect(kyPostMock).toHaveBeenCalledOnce();
    const w = writtenRange(0);
    expect(w.range).toBe("'Master'!A3:ZZ3");
    expect(w.values).toEqual([["", ""]]);

    expect(result.GOOGLE_SHEETS_ACTION_1.appendedRows).toBe(1);
  });

  it("blankRowAbove skips a row instead of writing an empty one", async () => {
    mockReadWithGrid(
      [
        ["Job No.", "Name"],
        ["0001", "X"],
      ],
      { title: "Master" },
    );

    const result = await run(
      {
        action: "append_row",
        spreadsheetId: "s",
        sheetName: "Master",
        blankRowAbove: true,
        columnMappings: { Name: "@<who>@" },
      },
      { who: "Ada" },
    );

    // The separator is a row we LEAVE EMPTY (row 3); the data goes one lower.
    // Nothing empty is sent to Sheets — an all-empty payload row is exactly what
    // made `:append` mis-place the data seven columns to the right.
    //
    // Two writes: the data row (row 4), then a repaint of the blank separator
    // (row 3) to white so the gap can't inherit the sheet's banding.
    expect(kyPostMock).toHaveBeenCalledTimes(2);
    const w = writtenRange(0);
    expect(w.range).toBe("'Master'!A4:ZZ4");
    expect(w.values).toEqual([["", "Ada"]]);

    // The separator sits at sheet row 3 → grid row 2, painted white; the data row
    // itself (row 4, with content) is NOT whitened.
    const whiten = postBody(1);
    expect(whiten.url).toContain(":batchUpdate");
    expect(whiten.url).not.toContain("values:batchUpdate");
    expect(whiten.requests).toEqual([
      {
        repeatCell: {
          range: {
            sheetId: 77,
            startRowIndex: 2,
            endRowIndex: 3,
            startColumnIndex: 0,
            endColumnIndex: 2,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
          fields: "userEnteredFormat.backgroundColor",
        },
      },
    ]);

    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.appendedRows).toBe(1);
    expect(out.rowIndex).toBe(4);
    expect(out.rowByHeader).toEqual({ "Job No": "", Name: "Ada" });
    expect(out.blankRowAbove).toBe(true);
  });

  it("no row is skipped when blankRowAbove is off", async () => {
    mockReadWithGrid(
      [
        ["Job No.", "Name"],
        ["0001", "X"],
      ],
      { title: "Master" },
    );

    const result = await run(
      {
        action: "append_row",
        spreadsheetId: "s",
        sheetName: "Master",
        columnMappings: { Name: "@<who>@" },
      },
      { who: "Ada" },
    );

    expect(writtenRange(0).range).toBe("'Master'!A3:ZZ3");
    expect(result.GOOGLE_SHEETS_ACTION_1.rowIndex).toBe(3);
    expect(result.GOOGLE_SHEETS_ACTION_1.blankRowAbove).toBe(false);
  });

  it("grows the grid when the tab is trimmed shorter than the target row", async () => {
    // A tab trimmed to exactly its 2 rows: the target row 3 doesn't exist yet.
    // `values:batchUpdate` (unlike :append) will NOT expand a sheet, so the grid
    // has to be grown first or the write falls outside it.
    mockReadWithGrid(
      [
        ["Job No.", "Name"],
        ["0001", "X"],
      ],
      { title: "Master", rowCount: 2, sheetId: 12 },
    );

    const result = await run({
      action: "append_row",
      spreadsheetId: "s",
      sheetName: "Master",
      columnMappings: { Name: "Ada" },
    });

    expect(kyPostMock).toHaveBeenCalledTimes(2);
    // First the structural growth…
    const grow = postBody(0);
    expect(grow.url).toContain(":batchUpdate");
    expect(grow.requests).toEqual([
      { appendDimension: { sheetId: 12, dimension: "ROWS", length: 1 } },
    ]);
    // …then the absolute write into the row that now exists.
    expect(writtenRange(1).range).toBe("'Master'!A3:ZZ3");
    expect(result.GOOGLE_SHEETS_ACTION_1.rowIndex).toBe(3);
  });

  it("throws NonRetriableError naming a blank required column", async () => {
    mockRead([["Name", "Mobile"]]); // header row only, no data

    await expect(
      run({
        action: "append_row",
        spreadsheetId: "s",
        sheetName: "Master",
        columnMappings: { Name: "Ada" },
        requiredColumns: ["Mobile"],
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);

    expect(kyPostMock).not.toHaveBeenCalled();
    expect(publishedStatuses).toContain("error");
  });

  it("throws NonRetriableError when the sheet has no header row", async () => {
    mockRead([]);

    await expect(
      run({
        action: "append_row",
        spreadsheetId: "s",
        sheetName: "Master",
        columnMappings: { Name: "Ada" },
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("maps a 403 read failure to a NonRetriableError (config/permission)", async () => {
    // readSheetTable rejects at `.json()`, mirroring ky's ResponsePromise.
    kyGetMock.mockReturnValue({
      json: async () => {
        throw new FakeHTTPError(403, { error: { message: "forbidden" } });
      },
    });

    await expect(
      run({
        action: "append_row",
        spreadsheetId: "s",
        sheetName: "Master",
        columnMappings: { Name: "Ada" },
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(publishedStatuses).toContain("error");
  });
});

describe("googleSheetsActionExecutor — find_rows", () => {
  it("returns every column, full matchCount, and unique columnValues", async () => {
    mockRead([
      ["Name", "Buyer", "Pending"],
      ["Ada", "Acme", "10"],
      ["Bo", "Acme", "0"],
      ["Cy", "Globex", "5"],
    ]);

    const result = await run({
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Pending", operator: "greater_than", value: "0" }],
    });

    // ≥1 match → routed down Found, with the legacy aliases for old workflows.
    expect(outputs(result)).toEqual(
      expect.arrayContaining(["found", "main", "source-1"]),
    );
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(2); // Ada (10) and Cy (5)
    expect(out.columns).toEqual(["Name", "Buyer", "Pending"]);
    expect(out.rows).toEqual([
      { Name: "Ada", Buyer: "Acme", Pending: "10" },
      { Name: "Cy", Buyer: "Globex", Pending: "5" },
    ]);
    expect(out.columnValues).toEqual({
      Name: JSON.stringify(["Ada", "Cy"]),
      Buyer: JSON.stringify(["Acme", "Globex"]),
      Pending: JSON.stringify(["10", "5"]),
    });
    // firstRow = the first matched row (every column, single values).
    expect(out.firstRow).toEqual({ Name: "Ada", Buyer: "Acme", Pending: "10" });
    expect(kyPostMock).not.toHaveBeenCalled();
    expect(publishedStatuses).toContain("success");
  });

  it("coerces a legacy saved read_rows node to find_rows (reads every row)", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Acme"],
      ["Cy", "Globex"],
    ]);

    const result = await run({
      action: "read_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      range: "A1:B2",
    });

    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.action).toBe("find_rows");
    // No conditions ⇒ every row matches — the closest surviving equivalent.
    expect(out.matchCount).toBe(2);
    expect(out.rows).toEqual([
      { Name: "Ada", Buyer: "Acme" },
      { Name: "Cy", Buyer: "Globex" },
    ]);
    expect(publishedStatuses).toContain("success");
  });

  it("defaults to all columns when none selected; 0 matches still lists columns", async () => {
    mockRead([
      ["Name", "Pending"],
      ["Ada", "0"],
    ]);

    const result = await run({
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Pending", operator: "greater_than", value: "0" }],
    });

    // 0 matches → routed down Not-found (only — no legacy aliases on this path).
    expect(outputs(result)).toEqual(["notfound"]);
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(0);
    expect(out.columns).toEqual(["Name", "Pending"]);
    expect(out.rows).toEqual([]);
    expect(out.columnValues).toEqual({ Name: "[]", Pending: "[]" });
    expect(out.firstRow).toEqual({});
  });

  it("fails when >1 row matches and onMultipleMatches is 'error'", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Acme"],
      ["Cy", "Acme"],
    ]);

    await expect(
      run({
        action: "find_rows",
        spreadsheetId: "s",
        sheetName: "Ledger",
        conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
        onMultipleMatches: "error",
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(publishedStatuses).toContain("error");
  });

  it("allows a single match under onMultipleMatches 'error'", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Acme"],
      ["Cy", "Globex"],
    ]);

    const result = await run({
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
      onMultipleMatches: "error",
    });
    expect(outputs(result)).toContain("found");
    expect(ctx(result).GOOGLE_SHEETS_ACTION_1.matchCount).toBe(1);
  });

  it("'last' resolves firstRow to the BOTTOM-most match, keeping every other field", async () => {
    mockRead([
      ["Name", "Buyer", "Pending"],
      ["Ada", "Acme", "10"],
      ["Bo", "Globex", "3"],
      ["Cy", "Acme", "5"],
    ]);

    const config = {
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
    };

    const lastOutcome = await run({ ...config, onMultipleMatches: "last" });
    const last = ctx(lastOutcome).GOOGLE_SHEETS_ACTION_1;
    const first = ctx(
      await run({ ...config, onMultipleMatches: "first" }),
    ).GOOGLE_SHEETS_ACTION_1;

    expect(last.firstRow).toEqual({ Name: "Cy", Buyer: "Acme", Pending: "5" });
    expect(first.firstRow).toEqual({
      Name: "Ada",
      Buyer: "Acme",
      Pending: "10",
    });
    // Only the acted-on row differs: the match list, the count and the
    // unique-value lists describe ALL matches in both modes.
    expect(last.matchCount).toBe(2);
    expect(last.rows).toEqual(first.rows);
    expect(last.columnValues).toEqual(first.columnValues);
    // Still a single, non-fan-out run down the Found branch.
    expect(isFanOut(lastOutcome)).toBe(false);
    expect(outputs(lastOutcome)).toContain("found");
  });

  it("'last' with a single match behaves exactly like 'first'", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Acme"],
      ["Cy", "Globex"],
    ]);

    const result = await run({
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
      onMultipleMatches: "last",
    });

    expect(outputs(result)).toContain("found");
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(1);
    expect(out.firstRow).toEqual({ Name: "Ada", Buyer: "Acme" });
  });

  it("'last' with zero matches routes Not-found with an empty firstRow", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Globex"],
    ]);

    const result = await run({
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
      onMultipleMatches: "last",
    });

    expect(outputs(result)).toEqual(["notfound"]);
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(0);
    expect(out.firstRow).toEqual({});
  });

  it("'last' stores the TAIL of the matches, so firstRow is inside the capped rows", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`P${i}`, "Acme"]);
    mockRead([["Name", "Buyer"], ...rows]);

    const out = ctx(
      await run({
        action: "find_rows",
        spreadsheetId: "s",
        sheetName: "Ledger",
        conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
        onMultipleMatches: "last",
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    expect(out.matchCount).toBe(120);
    // The stored window is the LAST 100 (P20…P119), not the first — otherwise
    // the row the run acted on would be missing from the grid it reports.
    expect(out.rows).toHaveLength(100);
    expect((out.rows as { Name: string }[])[0].Name).toBe("P20");
    expect(out.firstRow).toEqual({ Name: "P119", Buyer: "Acme" });
  });

  it("ANDs conditions and resolves in_list from a templated value", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Acme"],
      ["Bo", "Globex"],
      ["Cy", "Acme"],
    ]);

    const result = await run(
      {
        action: "find_rows",
        spreadsheetId: "s",
        sheetName: "Ledger",
        conditions: [
          { column: "Buyer", operator: "in_list", value: "@<ctx.buyers>@" },
        ],
      },
      { ctx: { buyers: JSON.stringify(["Acme"]) } },
    );

    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(2);
    expect(out.rows).toEqual([
      { Name: "Ada", Buyer: "Acme" },
      { Name: "Cy", Buyer: "Acme" },
    ]);
  });
});

describe("googleSheetsActionExecutor — find_rows multi-match fan-out", () => {
  it("'each' returns a fan-out outcome with one item per matched row", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Acme"],
      ["Bo", "Acme"],
      ["Cy", "Globex"],
    ]);

    const outcome = (await run({
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
      onMultipleMatches: "each",
    })) as unknown as FanOutOutcome;

    expect(isFanOut(outcome)).toBe(true);
    expect(outcome.items).toEqual([
      { Name: "Ada", Buyer: "Acme" },
      { Name: "Bo", Buyer: "Acme" },
    ]);
    const summary = outcome.context.GOOGLE_SHEETS_ACTION_1 as Record<
      string,
      unknown
    >;
    expect(summary.fannedOut).toBe(2);
    expect(summary.matchCount).toBe(2);
    expect(publishedStatuses).toContain("success");
  });

  it("'each' keeps every matched row as an item beyond the 100-row storage cap", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`P${i}`, "Acme"]);
    mockRead([["Name", "Buyer"], ...rows]);

    const outcome = (await run({
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
      onMultipleMatches: "each",
      maxFanOutItems: 200,
    })) as unknown as FanOutOutcome;

    expect(isFanOut(outcome)).toBe(true);
    expect(outcome.items).toHaveLength(120);
    // The parent's recorded summary stays capped at 100 rows (run-record
    // bloat guard); the full list reaches the children via `items` only.
    const summary = outcome.context.GOOGLE_SHEETS_ACTION_1 as {
      rows: unknown[];
      matchCount: number;
      fannedOut: number;
    };
    expect(summary.rows).toHaveLength(100);
    expect(summary.matchCount).toBe(120);
    expect(summary.fannedOut).toBe(120);
  });

  it("'each' fails (not truncates) when matches exceed maxFanOutItems", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Acme"],
      ["Bo", "Acme"],
      ["Cy", "Acme"],
    ]);

    await expect(
      run({
        action: "find_rows",
        spreadsheetId: "s",
        sheetName: "Ledger",
        conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
        onMultipleMatches: "each",
        maxFanOutItems: 2,
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(publishedStatuses).toContain("error");
  });

  it("'each' with zero matches routes Not-found instead of fanning out", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Globex"],
    ]);

    const outcome = await run({
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
      onMultipleMatches: "each",
    });

    // A 0-match run must NOT fan out: zero children would mark the whole
    // downstream sub-graph SKIPPED, when the Not-found branch is exactly what
    // should run. So even in "each" mode, no matches routes Not-found.
    expect(isFanOut(outcome)).toBe(false);
    expect(outputs(outcome)).toEqual(["notfound"]);
    expect(ctx(outcome).GOOGLE_SHEETS_ACTION_1.matchCount).toBe(0);
  });

  it("child run short-circuits on its seed: no Sheets call, first-match-shaped output", async () => {
    const result = await run(
      {
        action: "find_rows",
        spreadsheetId: "s",
        sheetName: "Ledger",
        conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
        onMultipleMatches: "each",
      },
      {
        GOOGLE_SHEETS_ACTION_1: {
          item: { Name: "Bo", Buyer: "Acme" },
          index: 2,
          total: 3,
          __fanOut: true,
        },
      },
    );

    expect(kyGetMock).not.toHaveBeenCalled();
    expect(refreshTokenMock).not.toHaveBeenCalled();
    // A child carries a matched row, so it flows down Found (with legacy aliases).
    expect(outputs(result)).toEqual(
      expect.arrayContaining(["found", "main", "source-1"]),
    );
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1 as Record<string, unknown>;
    // Same reference shape as a single "first"-mode match — plus the kept
    // marker so retries still short-circuit and nested guards still trip.
    expect(out.firstRow).toEqual({ Name: "Bo", Buyer: "Acme" });
    expect(out.rows).toEqual([{ Name: "Bo", Buyer: "Acme" }]);
    expect(out.matchCount).toBe(1);
    expect(out.columnValues).toEqual({
      Name: JSON.stringify(["Bo"]),
      Buyer: JSON.stringify(["Acme"]),
    });
    expect(out.index).toBe(2);
    expect(out.total).toBe(3);
    expect(out.__fanOut).toBe(true);
    expect(publishedStatuses).toContain("success");
  });

  it("'each' inside another node's fan-out child is rejected (nested guard)", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Acme"],
    ]);

    await expect(
      run(
        {
          action: "find_rows",
          spreadsheetId: "s",
          sheetName: "Ledger",
          conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
          onMultipleMatches: "each",
        },
        {
          OTHER_SHEETS_1: {
            item: { x: 1 },
            index: 1,
            total: 2,
            __fanOut: true,
          },
        },
      ),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(publishedStatuses).toContain("error");
  });
});

describe("googleSheetsActionExecutor — update_row", () => {
  // Ledger-shaped tab: one row per buyer, with running totals to accumulate.
  const ledger = [
    ["Service Buyer", "Estimated", "Pending", "Buyer Type"],
    ["Acme", "100", "40", "Government"],
    ["Globex", "50", "0", "Private"],
  ];

  // Rows are selected by the SAME conditions find_rows uses. What was once a
  // key column + key value is now just an `equals` condition.
  const matchAcme = [
    { column: "Service Buyer", operator: "equals", value: "Acme" },
  ];

  const baseConfig = {
    action: "update_row",
    spreadsheetId: "s",
    sheetName: "Ledger",
    conditions: matchAcme,
  };

  /** The values:batchUpdate body the update write posted. */
  function batchUpdateBody() {
    const [url, options] = kyPostMock.mock.calls[0] as [
      string,
      { json: { valueInputOption: string; data: unknown[] } },
    ];
    return { url, ...options.json };
  }

  it("overwrites mapped cells and leaves unmapped ones untouched (null), recording the row's prior state", async () => {
    mockRead(ledger);

    const result = await run({
      ...baseConfig,
      columnMappings: { Estimated: "125", Pending: "65" },
    });

    const body = batchUpdateBody();
    expect(body.url).toContain("/values:batchUpdate");
    expect(body.valueInputOption).toBe("USER_ENTERED");
    // Acme is data row 0 → sheet row 2. Service Buyer + Buyer Type are unmapped
    // ⇒ null ⇒ Sheets keeps their current values. The write carries each cell's
    // FINAL value, so an Inngest retry rewrites identical cells.
    expect(body.data).toEqual([
      { range: "'Ledger'!A2:ZZ2", values: [[null, 125, 65, null]] },
    ]);

    // The plan (read+match) and the write are SEPARATE Inngest steps: on a retry
    // of the idempotent write, the memoized plan is replayed rather than re-read,
    // so the write can never re-match a DIFFERENT row against a sheet its own
    // landed write already mutated.
    expect(stepNames).toEqual([
      "google-sheets-update-plan",
      "google-sheets-update-write",
    ]);

    // A row was written → routed down Updated, with the legacy aliases.
    expect(outputs(result)).toEqual(
      expect.arrayContaining(["updated", "main", "source-1"]),
    );
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.matched).toBe(true);
    expect(out.matchCount).toBe(1);
    expect(out.rowIndex).toBe(2);
    // rowByHeader is the row's RESULTING state — written cells where we wrote,
    // existing cells where we passed null (W1's SWITCH reads both off it).
    expect(out.rowByHeader).toEqual({
      "Service Buyer": "Acme",
      Estimated: "125",
      Pending: "65",
      "Buyer Type": "Government",
    });
    // …and previousRow is the state it replaced, so the execution page can show
    // before/after and highlight exactly which cells moved.
    expect(out.previousRow).toEqual({
      "Service Buyer": "Acme",
      Estimated: "100",
      Pending: "40",
      "Buyer Type": "Government",
    });
    expect(publishedStatuses).toContain("success");
  });

  it("writes an empty mapped value as a cell-clearing empty string, not null", async () => {
    mockRead(ledger);

    await run({
      ...baseConfig,
      // A mapped column whose template renders empty CLEARS the cell; only an
      // UNMAPPED column (null) is left alone. Pinning the distinction.
      columnMappings: { Pending: "@<nothing.here>@" },
    });

    expect(batchUpdateBody().data).toEqual([
      { range: "'Ledger'!A2:ZZ2", values: [[null, null, "", null]] },
    ]);
  });

  it("does NOTHING when no row matches the key — it never adds one", async () => {
    mockRead(ledger);

    const result = await run({
      ...baseConfig,
      conditions: [
        { column: "Service Buyer", operator: "equals", value: "Initech" },
      ],
      columnMappings: { Estimated: "80", Pending: "80" },
    });

    // This action only overwrites rows that already exist. Adding the missing
    // row is a different action's job.
    expect(kyPostMock).not.toHaveBeenCalled();
    // The plan step ran and found nothing; the write step never started.
    expect(stepNames).toEqual(["google-sheets-update-plan"]);

    // Nothing matched → routed down No-match (only), so the branch that adds the
    // missing row runs.
    expect(outputs(result)).toEqual(["no_match"]);
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.matched).toBe(false);
    expect(out.matchCount).toBe(0);
    // No row was touched, so there is nothing to show as before/after either.
    expect(out.rowByHeader).toBeUndefined();
    expect(out.previousRow).toBeUndefined();
    // It is a SUCCESS, not a failure — the No-match branch handles the missing row.
    expect(publishedStatuses).toContain("success");
  });

  it("REFUSES to run with an empty filter (it would overwrite every row)", async () => {
    mockRead(ledger);

    // matchRows is vacuously true with no active conditions — fine for a read
    // (find_rows just returns the tab), catastrophic for a write.
    for (const conditions of [
      undefined,
      [],
      // Present but inert: disabled, or naming no column.
      [
        {
          column: "Service Buyer",
          operator: "equals",
          value: "Acme",
          enabled: false,
        },
      ],
      [{ column: "", operator: "equals", value: "Acme" }],
    ]) {
      vi.clearAllMocks();
      publishedStatuses = [];
      refreshTokenMock.mockResolvedValue("token-123");
      kyPostMock.mockResolvedValue({});
      mockRead(ledger);

      await expect(
        run({
          ...baseConfig,
          conditions,
          columnMappings: { Pending: "0" },
        }),
      ).rejects.toBeInstanceOf(NonRetriableError);
      expect(kyPostMock).not.toHaveBeenCalled();
    }
  });

  it("never reassigns a Serial Number on a matched row", async () => {
    mockRead([
      ["Job No", "Service Buyer"],
      ["0001", "Acme"],
    ]);

    await run({
      ...baseConfig,
      columnMappings: { "Job No": serialToken, "Service Buyer": "Acme" },
    });

    // A serial belongs to the row for its lifetime: the token maps to null, so
    // the cell is left exactly as it was.
    expect(batchUpdateBody().data).toEqual([
      { range: "'Ledger'!A2:ZZ2", values: [[null, "Acme"]] },
    ]);
  });

  it("'error' mode fails on a duplicate key WITHOUT writing anything", async () => {
    mockRead([
      ["Service Buyer", "Pending"],
      ["Acme", "40"],
      ["Acme", "10"],
    ]);

    await expect(
      run({
        ...baseConfig,
        columnMappings: { Pending: "5" },
        onMultipleMatches: "error",
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    // The whole point of settling the policy BEFORE the write: a duplicate key
    // must not leave a half-applied update behind.
    expect(kyPostMock).not.toHaveBeenCalled();
    expect(publishedStatuses).toContain("error");
  });

  it("'first' mode (the default) updates only the first matching row", async () => {
    mockRead([
      ["Service Buyer", "Pending"],
      ["Acme", "40"],
      ["Acme", "10"],
    ]);

    const result = await run({
      ...baseConfig,
      columnMappings: { Pending: "5" },
    });

    // Only row 2 is written — the second Acme (sheet row 3) is left alone.
    expect(batchUpdateBody().data).toEqual([
      { range: "'Ledger'!A2:ZZ2", values: [[null, 5]] },
    ]);
    // matchCount still reports the truth, so a workflow can branch on it.
    expect(outputs(result)).toContain("updated");
    expect(ctx(result).GOOGLE_SHEETS_ACTION_1.matchCount).toBe(2);
  });

  it("'last' mode updates only the BOTTOM-most matching row", async () => {
    mockRead([
      ["Service Buyer", "Pending"],
      ["Acme", "40"],
      ["Globex", "0"],
      ["Acme", "10"],
    ]);

    const result = await run({
      ...baseConfig,
      columnMappings: { Pending: "5" },
      onMultipleMatches: "last",
    });

    // The second Acme is data row 2 → sheet row 4. The first Acme (row 2) is
    // left alone: exactly one row is written, as in "first" mode.
    expect(batchUpdateBody().data).toEqual([
      { range: "'Ledger'!A4:ZZ4", values: [[null, 5]] },
    ]);
    expect(outputs(result)).toContain("updated");
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    // matchCount still reports every match; rowIndex/previousRow/rowByHeader
    // describe the row this run actually wrote.
    expect(out.matchCount).toBe(2);
    expect(out.rowIndex).toBe(4);
    expect(out.previousRow).toEqual({ "Service Buyer": "Acme", Pending: "10" });
    expect(out.rowByHeader).toEqual({ "Service Buyer": "Acme", Pending: "5" });
  });

  it("'last' with no match writes nothing and routes No-match", async () => {
    mockRead([
      ["Service Buyer", "Pending"],
      ["Globex", "0"],
    ]);

    const result = await run({
      ...baseConfig,
      columnMappings: { Pending: "5" },
      onMultipleMatches: "last",
    });

    expect(kyPostMock).not.toHaveBeenCalled();
    expect(outputs(result)).toEqual(["no_match"]);
    expect(ctx(result).GOOGLE_SHEETS_ACTION_1.matched).toBe(false);
  });

  it("'each' mode writes EVERY matched row in one request and fans out one child run per row", async () => {
    mockRead([
      ["Service Buyer", "Pending"],
      ["Acme", "40"],
      ["Globex", "0"],
      ["Acme", "10"],
    ]);

    const outcome = (await run({
      ...baseConfig,
      columnMappings: { Pending: "5" },
      onMultipleMatches: "each",
    })) as unknown as FanOutOutcome;

    // ONE values:batchUpdate carrying a ValueRange per matched row — not N calls.
    // Globex (sheet row 3) is skipped: only the KEY's matches are written.
    expect(kyPostMock).toHaveBeenCalledOnce();
    expect(batchUpdateBody().data).toEqual([
      { range: "'Ledger'!A2:ZZ2", values: [[null, 5]] },
      { range: "'Ledger'!A4:ZZ4", values: [[null, 5]] },
    ]);

    expect(isFanOut(outcome)).toBe(true);
    expect(outcome.items).toEqual([
      { "Service Buyer": "Acme", Pending: "5" },
      { "Service Buyer": "Acme", Pending: "5" },
    ]);
    const summary = outcome.context.GOOGLE_SHEETS_ACTION_1 as Record<
      string,
      unknown
    >;
    expect(summary.fannedOut).toBe(2);
    expect(summary.matchCount).toBe(2);
    // `updatedRows` is only the internal carrier for the items — it must not
    // bloat the recorded run output.
    expect(summary.updatedRows).toBeUndefined();
  });

  it("'each' beyond the cap fails before writing", async () => {
    mockRead([
      ["Service Buyer", "Pending"],
      ["Acme", "1"],
      ["Acme", "2"],
      ["Acme", "3"],
    ]);

    await expect(
      run({
        ...baseConfig,
        columnMappings: { Pending: "5" },
        onMultipleMatches: "each",
        maxFanOutItems: 2,
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("a no-match run never fans out (zero items would SKIP the whole downstream sub-graph)", async () => {
    mockRead(ledger);

    const outcome = await run({
      ...baseConfig,
      conditions: [
        { column: "Service Buyer", operator: "equals", value: "Initech" },
      ],
      columnMappings: { Estimated: "80" },
      onMultipleMatches: "each",
    });

    // Fanning out zero children would skip everything downstream — which is
    // precisely the branch that has to run to handle the missing row. Instead a
    // 0-match "each" run routes No-match, in any mode.
    expect(isFanOut(outcome)).toBe(false);
    expect(outputs(outcome)).toEqual(["no_match"]);
    expect(ctx(outcome).GOOGLE_SHEETS_ACTION_1.matched).toBe(false);
  });

  it("a fan-out CHILD run reshapes its seed and touches Sheets not at all (the parent already wrote every row)", async () => {
    const result = await run(
      {
        ...baseConfig,
        columnMappings: { Pending: "5" },
        onMultipleMatches: "each",
      },
      {
        GOOGLE_SHEETS_ACTION_1: {
          item: { "Service Buyer": "Acme", Pending: "45" },
          index: 1,
          total: 2,
          __fanOut: true,
        },
      },
    );

    // No read, no write — the parent already wrote every matched row.
    expect(kyGetMock).not.toHaveBeenCalled();
    expect(kyPostMock).not.toHaveBeenCalled();

    // A child represents one updated row, so it flows down Updated.
    expect(outputs(result)).toEqual(
      expect.arrayContaining(["updated", "main", "source-1"]),
    );
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.action).toBe("update_row");
    expect(out.matched).toBe(true);
    expect(out.matchCount).toBe(1);
    // The same `rowByHeader.<col>` reference resolves in "first" and "each".
    expect(out.rowByHeader).toEqual({ "Service Buyer": "Acme", Pending: "45" });
    expect(publishedStatuses).toContain("success");
  });
});

describe("googleSheetsActionExecutor — append under a group", () => {
  // A "Grouped"-style tab: rows kept together by buyer, so a new job card has to
  // land INSIDE its buyer's block rather than at the bottom of the sheet.
  const grouped = [
    ["Service Buyer", "Job No", "Status"],
    ["Acme", "0001", "Open"], // data row 0 → sheet row 2
    ["Acme", "0002", "Closed"], // data row 1 → sheet row 3
    ["Globex", "0003", "Open"], // data row 2 → sheet row 4
  ];

  const baseConfig = {
    action: "append_row",
    position: "under_group",
    spreadsheetId: "s",
    sheetName: "Grouped",
    columnMappings: { "Service Buyer": "Acme", Status: "Open" },
  };

  const matchAcme = [
    { column: "Service Buyer", operator: "equals", value: "Acme" },
  ];

  it("coerces a legacy insert_row_adjacent node to an under-append and still inserts", async () => {
    mockReadWithGrid(grouped);

    // A node saved before the merge: the retired action + its `insertUnder`.
    // parseNodeConfig (inside the executor) rewrites it to append_row +
    // position, so it runs exactly like a modern under_group append.
    const result = await run({
      action: "insert_row_adjacent",
      insertUnder: "group",
      spreadsheetId: "s",
      sheetName: "Grouped",
      columnMappings: { "Service Buyer": "Acme", Status: "Open" },
      conditions: matchAcme,
    });

    expect(postBody(0).url).toContain("/s:batchUpdate");
    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.action).toBe("append_row");
    expect(out.insertedUnderGroup).toBe(true);
    expect(out.rowIndex).toBe(4);
    expect(isRouted(result)).toBe(false); // append never branches
  });

  it("forces a BLANK row inserted under a group to white (it inherited the group's color)", async () => {
    mockReadWithGrid(grouped);

    // A spacer: an under-group insert with NO column mapping, so every cell is
    // empty. `insertDimension inheritFromBefore` copies Acme's banding onto it —
    // the exact way a blank spacer came out tinted — so it must be repainted white.
    const result = await run({
      ...baseConfig,
      columnMappings: {},
      conditions: matchAcme,
    });

    // Three writes: structural insert, the (empty) values, then the whitening.
    expect(kyPostMock).toHaveBeenCalledTimes(3);
    expect(postBody(0).url).toContain("/s:batchUpdate");
    expect(postBody(0).url).not.toContain("values:batchUpdate");
    // The blank row landed at sheet row 4 (under Acme's block).
    expect(writtenRange(1).range).toBe("'Grouped'!A4:ZZ4");
    expect(writtenRange(1).values).toEqual([["", "", ""]]);

    // Sheet row 4 → grid row 3, painted white across the 3-column header band.
    const whiten = postBody(2);
    expect(whiten.url).toContain(":batchUpdate");
    expect(whiten.url).not.toContain("values:batchUpdate");
    expect(whiten.requests).toEqual([
      {
        repeatCell: {
          range: {
            sheetId: 77,
            startRowIndex: 3,
            endRowIndex: 4,
            startColumnIndex: 0,
            endColumnIndex: 3,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
          fields: "userEnteredFormat.backgroundColor",
        },
      },
    ]);
    expect(result.GOOGLE_SHEETS_ACTION_1.rowIndex).toBe(4);
  });

  it("does NOT whiten a row inserted under a group when it has content", async () => {
    mockReadWithGrid(grouped);

    // A normal under-group insert (mapped cells) keeps the group banding it
    // inherited — only BLANK inserts are repainted. So no whitening write.
    await run({ ...baseConfig, conditions: matchAcme });

    // Structural insert + values write, and nothing more.
    expect(kyPostMock).toHaveBeenCalledTimes(2);
    expect(
      kyPostMock.mock.calls.some(([, opts]) =>
        (opts as { json?: { requests?: unknown[] } }).json?.requests?.some(
          (r) =>
            typeof r === "object" &&
            r !== null &&
            "repeatCell" in (r as Record<string, unknown>),
        ),
      ),
    ).toBe(false);
  });

  it("inserts a row directly under the LAST row of the matching group, then fills it", async () => {
    mockReadWithGrid(grouped);

    const result = await run({ ...baseConfig, conditions: matchAcme });

    // Acme's block is data rows 0-1 (sheet rows 2-3), with Globex below it — so
    // room has to be MADE at grid row 3 (0-based, header at 0), which is sheet
    // row 4. inheritFromBefore carries the block's formatting down onto it.
    const insert = postBody(0);
    expect(insert.url).toContain("/s:batchUpdate");
    expect(insert.requests).toEqual([
      {
        insertDimension: {
          range: {
            sheetId: 77,
            dimension: "ROWS",
            startIndex: 3,
            endIndex: 4,
          },
          inheritFromBefore: true,
        },
      },
    ]);

    // …then the blank row it opened is filled, USER_ENTERED so numbers and dates
    // are parsed exactly as on every other Sheets write.
    const write = postBody(1);
    expect(write.url).toContain("/values:batchUpdate");
    expect(write.valueInputOption).toBe("USER_ENTERED");
    expect(write.data).toEqual([
      { range: "'Grouped'!A4:ZZ4", values: [["Acme", "", "Open"]] },
    ]);

    // The insert and the write are SEPARATE Inngest steps: on a retry of the
    // write, the memoized insert is replayed rather than re-run, so a failed
    // write can never leave a second blank row behind.
    expect(stepNames).toEqual([
      "google-sheets-insert-adjacent",
      "google-sheets-insert-adjacent-write",
    ]);

    // insert_row_adjacent does NOT branch — it keeps the single default output.
    expect(isRouted(result)).toBe(false);
    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.insertedUnderGroup).toBe(true);
    expect(out.matchCount).toBe(2); // the group's size, not a dilemma
    expect(out.rowIndex).toBe(4);
    expect(out.rowByHeader).toEqual({
      "Service Buyer": "Acme",
      "Job No": "",
      Status: "Open",
    });
    expect(publishedStatuses).toContain("success");
  });

  it("appends when the matching group already ends at the bottom (no insert needed)", async () => {
    mockReadWithGrid(grouped);

    const result = await run({
      ...baseConfig,
      columnMappings: { "Service Buyer": "Globex", Status: "Open" },
      conditions: [
        { column: "Service Buyer", operator: "equals", value: "Globex" },
      ],
    });

    // Globex's block ends at the last data row, so no structural insert is
    // needed — the row is simply the first free one, written to its ABSOLUTE
    // range (never `:append`, which would pick its own destination).
    expect(kyPostMock).toHaveBeenCalledOnce();
    const w = writtenRange(0);
    expect(w.url).toContain("values:batchUpdate");
    expect(w.url).not.toContain(":append");
    expect(w.range).toBe("'Grouped'!A5:ZZ5");
    expect(w.values).toEqual([["Globex", "", "Open"]]);
    expect(stepNames).toEqual([
      "google-sheets-insert-adjacent",
      "google-sheets-insert-adjacent-write",
    ]);

    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.insertedUnderGroup).toBe(true);
    expect(out.rowIndex).toBe(5); // 3 data rows + header + 1
  });

  it("starts a new group at the bottom when nothing matches", async () => {
    mockReadWithGrid(grouped);

    const result = await run({
      ...baseConfig,
      columnMappings: { "Service Buyer": "Initech", Status: "Open" },
      conditions: [
        { column: "Service Buyer", operator: "equals", value: "Initech" },
      ],
    });

    // A brand-new buyer: no group to join, so the row goes to the first free
    // row of the tab, starting a group of its own.
    expect(kyPostMock).toHaveBeenCalledOnce();
    expect(writtenRange(0).range).toBe("'Grouped'!A5:ZZ5");
    expect(writtenRange(0).values).toEqual([["Initech", "", "Open"]]);

    const out = result.GOOGLE_SHEETS_ACTION_1;
    // Matching nothing is a normal outcome here — a row is still written.
    expect(out.insertedUnderGroup).toBe(false);
    expect(out.matchCount).toBe(0);
    expect(out.rowIndex).toBe(5); // 3 data rows + header + 1
    expect(publishedStatuses).toContain("success");
  });

  it("appends to a tab that has only a header row (no data yet)", async () => {
    mockReadWithGrid([["Service Buyer", "Job No", "Status"]]);

    const result = await run({
      ...baseConfig,
      conditions: matchAcme,
    });

    expect(writtenRange(0).range).toBe("'Grouped'!A2:ZZ2");
    expect(writtenRange(0).values).toEqual([["Acme", "", "Open"]]);
    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.rowIndex).toBe(2);
  });

  it("REFUSES to run with an empty filter (it picks the group — without it there is none)", async () => {
    for (const conditions of [
      undefined,
      [],
      // Present but inert: disabled, or naming no column.
      [
        {
          column: "Service Buyer",
          operator: "equals",
          value: "Acme",
          enabled: false,
        },
      ],
      [{ column: "", operator: "equals", value: "Acme" }],
    ]) {
      vi.clearAllMocks();
      publishedStatuses = [];
      stepNames = [];
      refreshTokenMock.mockResolvedValue("token-123");
      kyPostMock.mockResolvedValue({});
      mockReadWithGrid(grouped);

      await expect(run({ ...baseConfig, conditions })).rejects.toBeInstanceOf(
        NonRetriableError,
      );
      expect(kyPostMock).not.toHaveBeenCalled();
    }
  });

  it("numbers a Serial column from the whole tab, not just the group", async () => {
    mockReadWithGrid(grouped);

    await run({
      ...baseConfig,
      columnMappings: {
        "Service Buyer": "Acme",
        "Job No": serialToken,
        Status: "Open",
      },
      conditions: matchAcme,
    });

    // Acme's own rows stop at 0002, but the sheet's max is Globex's 0003 — a job
    // number has to be unique across the TAB, so the next one is 0004 (written
    // as text so USER_ENTERED keeps the leading zeros).
    expect(postBody(1).data).toEqual([
      { range: "'Grouped'!A4:ZZ4", values: [["Acme", "'0004", "Open"]] },
    ]);
  });

  it("throws NonRetriableError naming a blank required column, before touching the sheet", async () => {
    mockReadWithGrid(grouped);

    await expect(
      run({
        ...baseConfig,
        conditions: matchAcme,
        requiredColumns: ["Job No"],
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);

    // Nothing was inserted — the row is validated before any room is made for it.
    expect(kyPostMock).not.toHaveBeenCalled();
    expect(publishedStatuses).toContain("error");
  });

  it("fills a column from the row it is placed under (@<anchorRow.…>@)", async () => {
    mockReadWithGrid(grouped);

    await run({
      ...baseConfig,
      // The anchor is the LAST row of the group (Acme / 0002 / Closed), so the
      // new row carries THAT row's Job No — not the first match's.
      columnMappings: {
        "Service Buyer": "@<anchorRow.Service Buyer>@",
        "Job No": "@<anchorRow.Job No>@",
        Status: "Follow-up",
      },
      conditions: matchAcme,
    });

    // The anchor's Job No is a PADDED id, so it is force-texted (`'0002`) on the
    // way in. Written bare, USER_ENTERED would store it as the number 2 and the
    // padding would be gone — the same way a job number referenced into a second
    // sheet used to arrive as "9".
    expect(postBody(1).data).toEqual([
      { range: "'Grouped'!A4:ZZ4", values: [["Acme", "'0002", "Follow-up"]] },
    ]);
  });
});

describe("googleSheetsActionExecutor — append under each matching row", () => {
  // Acme's rows are NOT contiguous here, so each match anchors its own new row
  // at a different depth — which is what makes the bottom-up insert order and
  // the row-number shifting load-bearing.
  const grouped = [
    ["Service Buyer", "Job No", "Status"],
    ["Acme", "0001", "Open"], // data row 0 → sheet row 2  ← match
    ["Globex", "0002", "Open"], // data row 1 → sheet row 3
    ["Acme", "0003", "Open"], // data row 2 → sheet row 4  ← match
    ["Initech", "0004", "Open"], // data row 3 → sheet row 5
  ];

  const eachRow = {
    action: "append_row",
    position: "under_each",
    spreadsheetId: "s",
    sheetName: "Grouped",
    conditions: [
      { column: "Service Buyer", operator: "equals", value: "Acme" },
    ],
    columnMappings: {
      "Service Buyer": "@<anchorRow.Service Buyer>@",
      "Job No": serialToken,
      Status: "Follow-up",
    },
  };

  it("inserts one row under EVERY match, bottom-up, in a single batchUpdate", async () => {
    mockReadWithGrid(grouped);

    const outcome = (await run(eachRow)) as unknown as FanOutOutcome;

    // ONE structural request carrying both inserts — not one call per match.
    // They are ordered BOTTOM-UP (grid row 4 before grid row 2): inserting a row
    // shifts everything below it down, so doing the deepest one first leaves the
    // higher index exactly where it was computed.
    const insert = postBody(0);
    expect(insert.url).toContain("/s:batchUpdate");
    expect(insert.requests).toEqual([
      {
        insertDimension: {
          range: { sheetId: 77, dimension: "ROWS", startIndex: 4, endIndex: 5 },
          inheritFromBefore: true,
        },
      },
      {
        insertDimension: {
          range: { sheetId: 77, dimension: "ROWS", startIndex: 2, endIndex: 3 },
          inheritFromBefore: true,
        },
      },
    ]);

    // …and ONE values write for both rows. Row 3 is under Acme/0001; row 6 is
    // under Acme/0003 — pushed one further down by the row inserted above it.
    // Each row copies ITS OWN anchor, and the serial keeps counting up across
    // the rows this run adds (0005, then 0006 — not 0005 twice).
    expect(postBody(1).data).toEqual([
      { range: "'Grouped'!A3:ZZ3", values: [["Acme", "'0005", "Follow-up"]] },
      { range: "'Grouped'!A6:ZZ6", values: [["Acme", "'0006", "Follow-up"]] },
    ]);
    expect(kyPostMock).toHaveBeenCalledTimes(2);

    // One child run per inserted row, each carrying its own row, where it
    // landed, and the row it sits under — so siblings are distinguishable.
    expect(isFanOut(outcome)).toBe(true);
    expect(outcome.items).toEqual([
      {
        row: { "Service Buyer": "Acme", "Job No": "0005", Status: "Follow-up" },
        rowIndex: 3,
        anchorRow: {
          "Service Buyer": "Acme",
          "Job No": "0001",
          Status: "Open",
        },
      },
      {
        row: { "Service Buyer": "Acme", "Job No": "0006", Status: "Follow-up" },
        rowIndex: 6,
        anchorRow: {
          "Service Buyer": "Acme",
          "Job No": "0003",
          Status: "Open",
        },
      },
    ]);

    const summary = outcome.context.GOOGLE_SHEETS_ACTION_1 as Record<
      string,
      unknown
    >;
    expect(summary.fannedOut).toBe(2);
    expect(summary.matchCount).toBe(2);
    // Recorded for the run view: the rows written, and WHERE each one landed.
    expect(summary.insertedRows).toHaveLength(2);
    expect(summary.insertedRowIndexes).toEqual([3, 6]);
  });

  it("grows the grid first when the deepest insert would fall outside it", async () => {
    // A tab trimmed to exactly its data (header + 4 rows = 5 grid rows), with
    // the LAST data row among the matches. A single match at the bottom would
    // just append; several matches must INSERT under each — and the deepest of
    // those inserts addresses a grid row that does not exist yet.
    mockReadWithGrid(grouped, { rowCount: 5 });

    await run({
      ...eachRow,
      // Job No 0003 (data row 2) and 0004 (data row 3, the last one).
      conditions: [
        { column: "Job No", operator: "in_list", value: "0003,0004" },
      ],
    });

    expect(postBody(0).requests).toEqual([
      // Room for the deepest insert (grid row 5) — in the SAME batch, so it is
      // still one request and the grid is never left grown-but-unused.
      { appendDimension: { sheetId: 77, dimension: "ROWS", length: 1 } },
      {
        insertDimension: {
          range: { sheetId: 77, dimension: "ROWS", startIndex: 5, endIndex: 6 },
          inheritFromBefore: true,
        },
      },
      {
        insertDimension: {
          range: { sheetId: 77, dimension: "ROWS", startIndex: 4, endIndex: 5 },
          inheritFromBefore: true,
        },
      },
    ]);
  });

  it("fails BEFORE writing when the matches exceed the fan-out cap", async () => {
    mockReadWithGrid(grouped);

    await expect(run({ ...eachRow, maxFanOutItems: 1 })).rejects.toBeInstanceOf(
      NonRetriableError,
    );

    // The cap must be enforced ahead of the insert — failing afterwards would
    // leave rows in the sheet that the user asked not to be written.
    expect(kyPostMock).not.toHaveBeenCalled();
    expect(publishedStatuses).toContain("error");
  });

  it("does not fan out when nothing matched (it wrote one row, starting a new group)", async () => {
    mockReadWithGrid(grouped);

    const outcome = await run({
      ...eachRow,
      conditions: [
        { column: "Service Buyer", operator: "equals", value: "Umbrella" },
      ],
    });

    // One row was written (a new group at the bottom) — there is no set of
    // matched rows to fan out over, and fanning out ZERO children would mark
    // everything downstream SKIPPED.
    expect(isFanOut(outcome as unknown as FanOutOutcome)).toBe(false);
    const out = outcome.GOOGLE_SHEETS_ACTION_1;
    expect(out.insertedUnderGroup).toBe(false);
    expect(out.matchCount).toBe(0);
    expect(out.rowIndex).toBe(6); // 4 data rows + header + 1
  });

  it("a fan-out CHILD reshapes its seed and touches Sheets not at all", async () => {
    const result = await run(eachRow, {
      GOOGLE_SHEETS_ACTION_1: {
        item: {
          row: { "Service Buyer": "Acme", "Job No": "0006" },
          rowIndex: 6,
          anchorRow: { "Service Buyer": "Acme", "Job No": "0003" },
        },
        index: 2,
        total: 2,
        __fanOut: true,
      },
    });

    // The parent already inserted every row — a child must never insert again.
    expect(kyGetMock).not.toHaveBeenCalled();
    expect(kyPostMock).not.toHaveBeenCalled();

    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.rowByHeader).toEqual({
      "Service Buyer": "Acme",
      "Job No": "0006",
    });
    expect(out.rowIndex).toBe(6);
    expect(out.anchorRow).toEqual({
      "Service Buyer": "Acme",
      "Job No": "0003",
    });
    expect(out.matchCount).toBe(1);
    expect(publishedStatuses).toContain("success");
  });

  it("rejects 'one row per match' inside another node's fan-out child (nested guard)", async () => {
    mockReadWithGrid(grouped);

    await expect(
      run(eachRow, {
        OTHER_SHEETS_1: { item: { x: 1 }, index: 1, total: 2, __fanOut: true },
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });
});

describe("googleSheetsActionExecutor — color_rows", () => {
  // Row 2 is Done, row 3 Blocked, row 4 Done — and row 5 is BOTH, which is what
  // makes "first rule wins" observable.
  const statuses = [
    ["Job", "Status"],
    ["A", "Done"],
    ["B", "Blocked"],
    ["C", "Done"],
    ["D", "Done Blocked"],
  ];

  const rule = (color: string, value: string, operator = "equals") => ({
    color,
    conditions: [{ column: "Status", operator, value, enabled: true }],
  });

  const twoRules = {
    action: "color_rows",
    spreadsheetId: "sheet1",
    sheetName: "Grouped",
    colorRules: [rule("#22c55e", "Done"), rule("#ef4444", "Blocked")],
  };

  /** The repeatCell requests of the single structural batchUpdate. */
  function paintRequests(index = 0) {
    const body = postBody(index);
    return (body.requests ?? []) as Array<{
      repeatCell: {
        range: {
          sheetId: number;
          startRowIndex: number;
          endRowIndex: number;
          startColumnIndex?: number;
          endColumnIndex?: number;
        };
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: number; green: number; blue: number };
          };
        };
        fields: string;
      };
    }>;
  }

  it("paints every matched row in ONE batchUpdate, across the used columns", async () => {
    mockReadWithGrid(statuses, { sheetId: 42 });

    const outcome = await run(twoRules);

    expect(kyPostMock).toHaveBeenCalledOnce();
    expect(postBody(0).url).toContain(":batchUpdate");
    expect(postBody(0).url).not.toContain("values:batchUpdate");

    const requests = paintRequests();
    // 3 of the 4 data rows: these rules use `equals`, so "Done Blocked" matches
    // neither and is left alone — an unmatched row must never be repainted.
    expect(requests).toHaveLength(3);

    for (const r of requests) {
      expect(r.repeatCell.range.sheetId).toBe(42);
      expect(r.repeatCell.fields).toBe("userEnteredFormat.backgroundColor");
      // Bounded to the USED columns: the fixture's header row is
      // ["Job", "Status"], so the paint spans exactly columns A–B and stops
      // there rather than banding across the empty rest of the grid.
      expect(r.repeatCell.range.startColumnIndex).toBe(0);
      expect(r.repeatCell.range.endColumnIndex).toBe(2);
    }

    // Data row i is grid row i + 1 (the header occupies grid row 0), and each
    // request spans exactly one row. Emitted in ascending sheet order.
    expect(requests.map((r) => r.repeatCell.range.startRowIndex)).toEqual([
      1, 2, 3,
    ]);
    expect(requests.map((r) => r.repeatCell.range.endRowIndex)).toEqual([
      2, 3, 4,
    ]);

    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(3);
    // Sheet row numbers (1-based, past the header), ascending.
    expect(out.rowIndexes).toEqual([2, 3, 4]);
  });

  it("colors every matched row when set to all (the explicit default)", async () => {
    mockReadWithGrid(statuses, { sheetId: 42 });

    const outcome = await run({ ...twoRules, onMultipleColorMatches: "all" });

    // "all" is identical to leaving the mode unset — every match is painted, so
    // matched and colored counts coincide.
    expect(paintRequests()).toHaveLength(3);
    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(3);
    expect(out.coloredCount).toBe(3);
    expect(out.rowIndexes).toEqual([2, 3, 4]);
  });

  it("colors only the topmost matched row when set to first", async () => {
    mockReadWithGrid(statuses, { sheetId: 42 });

    const outcome = await run({
      ...twoRules,
      onMultipleColorMatches: "first",
    });

    // Three rows match, but only ONE is painted — the topmost (row 2, "A" Done).
    expect(kyPostMock).toHaveBeenCalledOnce();
    const requests = paintRequests();
    expect(requests).toHaveLength(1);
    // Grid row 1 = sheet row 2.
    expect(requests[0].repeatCell.range.startRowIndex).toBe(1);
    expect(requests[0].repeatCell.range.endRowIndex).toBe(2);

    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    // matchCount is the TRUE match count (3), coloredCount is what was painted (1).
    expect(out.matchCount).toBe(3);
    expect(out.coloredCount).toBe(1);
    expect(out.rowIndexes).toEqual([2]);
    expect(out.colors).toEqual(["#22c55e"]);
    // Still the happy branch, with the legacy aliases.
    expect(outputs(outcome)).toEqual(["colored", "main", "source-1"]);
  });

  it("colors only the bottom-most matched row when set to last", async () => {
    mockReadWithGrid(statuses, { sheetId: 42 });

    const outcome = await run({
      ...twoRules,
      onMultipleColorMatches: "last",
    });

    // Three rows match (2, 3, 4); only the last one — row 4 ("C" Done) — is
    // painted, in the Done rule's green.
    expect(kyPostMock).toHaveBeenCalledOnce();
    const requests = paintRequests();
    expect(requests).toHaveLength(1);
    // Grid row 3 = sheet row 4.
    expect(requests[0].repeatCell.range.startRowIndex).toBe(3);
    expect(requests[0].repeatCell.range.endRowIndex).toBe(4);

    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    // Three matched, one painted.
    expect(out.matchCount).toBe(3);
    expect(out.coloredCount).toBe(1);
    expect(out.rowIndexes).toEqual([4]);
    expect(out.colors).toEqual(["#22c55e"]);
    expect(outputs(outcome)).toEqual(["colored", "main", "source-1"]);
  });

  it("first picks the sheet-topmost match, not the first rule's match", async () => {
    mockReadWithGrid(statuses, { sheetId: 42 });

    // Rule order is Blocked-then-Done, but row 2 ("Done") sits above row 3
    // ("Blocked"). "first" paints row 2 in rule 2's red — proving the topmost
    // ROW wins, not the first RULE.
    const outcome = await run({
      action: "color_rows",
      spreadsheetId: "sheet1",
      sheetName: "Grouped",
      colorRules: [rule("#22c55e", "Blocked"), rule("#ef4444", "Done")],
      onMultipleColorMatches: "first",
    });

    const requests = paintRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].repeatCell.range.startRowIndex).toBe(1);
    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.rowIndexes).toEqual([2]);
    expect(out.colors).toEqual(["#ef4444"]);
  });

  it("first with no matches still writes nothing and routes No-match", async () => {
    mockReadWithGrid(statuses);

    const outcome = await run({
      ...twoRules,
      colorRules: [rule("#22c55e", "Shipped")],
      onMultipleColorMatches: "first",
    });

    expect(kyPostMock).not.toHaveBeenCalled();
    expect(outputs(outcome)).toEqual(["no_match"]);
    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(0);
    expect(out.coloredCount).toBe(0);
  });

  it("last with no matches still writes nothing and routes No-match", async () => {
    mockReadWithGrid(statuses);

    // Exercises the slice(-1) branch on an empty match set — it must stay a
    // clean no-op, symmetric with the "first" case above.
    const outcome = await run({
      ...twoRules,
      colorRules: [rule("#22c55e", "Shipped")],
      onMultipleColorMatches: "last",
    });

    expect(kyPostMock).not.toHaveBeenCalled();
    expect(outputs(outcome)).toEqual(["no_match"]);
    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(0);
    expect(out.coloredCount).toBe(0);
  });

  it("gives a row matching two rules the FIRST rule's color", async () => {
    mockReadWithGrid(statuses);

    // "Done Blocked" (row 5) contains both — matched by rule 1 and rule 2.
    const outcome = await run({
      ...twoRules,
      colorRules: [
        rule("#22c55e", "Done", "contains"),
        rule("#ef4444", "Blocked", "contains"),
      ],
    });

    const green = { red: 34 / 255, green: 197 / 255, blue: 94 / 255 };
    const red = { red: 239 / 255, green: 68 / 255, blue: 68 / 255 };
    const painted = paintRequests().map(
      (r) => r.repeatCell.cell.userEnteredFormat.backgroundColor,
    );

    // Rows: A Done→green, B Blocked→red, C Done→green, D BOTH→green (rule 1).
    expect(painted).toEqual([green, red, green, green]);
    expect(ctx(outcome).GOOGLE_SHEETS_ACTION_1.colors).toEqual([
      "#22c55e",
      "#ef4444",
      "#22c55e",
      "#22c55e",
    ]);
  });

  it("writes NOTHING and routes No-match when no row matches any rule", async () => {
    mockReadWithGrid(statuses);

    const outcome = await run({
      ...twoRules,
      colorRules: [rule("#22c55e", "Shipped")],
    });

    // A colouring run that matched nothing must not touch the sheet at all.
    expect(kyPostMock).not.toHaveBeenCalled();
    expect(outputs(outcome)).toEqual(["no_match"]);
    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(0);
    // Columns are still recorded so the run view can render its headers.
    expect(out.columns).toEqual(["Job", "Status"]);
    expect(publishedStatuses).toContain("success");
  });

  it("routes Colored (with the legacy aliases) when rows were painted", async () => {
    mockReadWithGrid(statuses);

    const outcome = await run({
      ...twoRules,
      colorRules: [rule("#22c55e", "Blocked")],
    });

    // The happy branch carries main/source-1 so a pre-branching edge still fires.
    expect(outputs(outcome)).toEqual(["colored", "main", "source-1"]);
  });

  it("refuses a rule whose filter is empty — it would color every row", async () => {
    mockReadWithGrid(statuses);

    await expect(
      run({
        ...twoRules,
        colorRules: [
          rule("#22c55e", "Done"),
          { color: "#ef4444", conditions: [] },
        ],
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("refuses a run with no rules at all", async () => {
    mockReadWithGrid(statuses);

    await expect(run({ ...twoRules, colorRules: [] })).rejects.toBeInstanceOf(
      NonRetriableError,
    );
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("refuses to paint more rows than one run may color", async () => {
    // 1,001 data rows all matching one rule — one repeatCell each would build a
    // batchUpdate too large to send, so the run must fail BEFORE writing rather
    // than after committing the user's whole tab to a request Sheets rejects.
    const many = [
      ["Job", "Status"],
      ...Array.from({ length: 1001 }, (_, i) => [`J${i}`, "Done"]),
    ];
    mockReadWithGrid(many);

    await expect(
      run({ ...twoRules, colorRules: [rule("#22c55e", "Done")] }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("skips the grid lookup entirely when nothing matches", async () => {
    mockReadWithGrid(statuses);

    await run({ ...twoRules, colorRules: [rule("#22c55e", "Shipped")] });

    // Only the values read — the sheetId is needed solely to build the write,
    // so a no-op run must not pay for the metadata round-trip.
    expect(kyGetMock).toHaveBeenCalledOnce();
    expect(kyGetMock.mock.calls[0][0]).toContain("/values/");
  });

  it("refuses a tab with no header row instead of painting a zero-width range", async () => {
    // No header row: every row reads as an empty object, so an `is_empty`
    // condition would "match" everything — and the paint would have no width.
    mockReadWithGrid([[], ["A"], ["B"]]);

    await expect(
      run({
        ...twoRules,
        colorRules: [
          {
            color: "#22c55e",
            conditions: [
              { column: "Status", operator: "is_empty", enabled: true },
            ],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed color instead of writing a partial repaint", async () => {
    mockReadWithGrid(statuses);

    await expect(
      run({ ...twoRules, colorRules: [rule("not-a-color", "Done")] }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });
});

describe("googleSheetsActionExecutor — append_heading", () => {
  const table = [
    ["Service Buyer", "Job No", "Status"],
    ["Acme", "0001", "Open"], // data row 0 → sheet row 2
    ["Globex", "0002", "Open"], // data row 1 → sheet row 3
    ["Acme", "0003", "Open"], // data row 2 → sheet row 4
  ];

  const heading = {
    action: "append_heading",
    spreadsheetId: "s",
    sheetName: "Grouped",
    headingText: "Invoices — March",
  };

  const matchAcme = [
    { column: "Service Buyer", operator: "equals", value: "Acme" },
  ];

  /** The requests of the Nth batchUpdate, typed for the two heading shapes. */
  function formatRequests(index: number) {
    return (postBody(index).requests ?? []) as Array<{
      repeatCell?: {
        range: Record<string, number>;
        cell: { userEnteredFormat: Record<string, unknown> };
        fields: string;
      };
      mergeCells?: { range: Record<string, number>; mergeType: string };
    }>;
  }

  it("writes the text to column A, then styles and merges the band", async () => {
    mockReadWithGrid(table);

    const result = await run(heading);

    // The value goes to the first free row (5) at its ABSOLUTE range, as a
    // ONE-cell row — Sheets leaves B..ZZ alone, which is what the merge then
    // swallows.
    expect(writtenRange(0).range).toBe("'Grouped'!A5:ZZ5");
    expect(writtenRange(0).values).toEqual([["Invoices — March"]]);

    // …then ONE format batchUpdate: style the band, THEN merge it. Order
    // matters — a merge inherits the top-left cell's format.
    expect(postBody(1).url).toContain(":batchUpdate");
    expect(postBody(1).url).not.toContain("values:batchUpdate");
    const requests = formatRequests(1);
    expect(requests).toHaveLength(2);

    // Sheet row 5 → grid row 4, across the 3-column header band.
    const band = {
      sheetId: 77,
      startRowIndex: 4,
      endRowIndex: 5,
      startColumnIndex: 0,
      endColumnIndex: 3,
    };
    expect(requests[0].repeatCell?.range).toEqual(band);
    expect(requests[0].repeatCell?.cell.userEnteredFormat).toEqual({
      backgroundColor: { red: 1, green: 1, blue: 1 },
      horizontalAlignment: "CENTER",
      verticalAlignment: "MIDDLE",
      textFormat: {
        bold: true,
        italic: false,
        fontSize: 12,
        foregroundColor: { red: 0, green: 0, blue: 0 },
      },
    });
    // Only the sub-fields the heading owns — so the row keeps the tab's number
    // format, borders and padding.
    expect(requests[0].repeatCell?.fields).toBe(
      "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)",
    );
    expect(requests[1].mergeCells).toEqual({
      range: band,
      mergeType: "MERGE_ALL",
    });

    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.action).toBe("append_heading");
    expect(out.headingText).toBe("Invoices — March");
    expect(out.rowIndex).toBe(5);
    expect(out.mergedColumns).toBe(3);
    // A heading has no columns, so it must not claim a header-keyed row.
    expect(out.rowByHeader).toBeUndefined();
  });

  it("splits plan from write so a retry cannot add a second heading", async () => {
    mockReadWithGrid(table);

    await run(heading);

    // The row number is settled in a memoized step BEFORE the write, exactly as
    // a mapped append is — a replay rewrites the same cells rather than reading
    // a sheet the landed write already changed. The merge is its own step, after
    // the text exists.
    expect(stepNames).toEqual([
      "google-sheets-append-plan",
      "google-sheets-append-write",
      "google-sheets-style-heading-rows",
    ]);
  });

  it("honours a custom format", async () => {
    mockReadWithGrid(table);

    await run({
      ...heading,
      headingFormat: {
        bold: false,
        italic: true,
        fontSize: 18,
        textColor: "#ff0000",
        backgroundColor: "#000000",
        align: "LEFT",
      },
    });

    expect(formatRequests(1)[0].repeatCell?.cell.userEnteredFormat).toEqual({
      backgroundColor: { red: 0, green: 0, blue: 0 },
      horizontalAlignment: "LEFT",
      verticalAlignment: "MIDDLE",
      textFormat: {
        bold: false,
        italic: true,
        fontSize: 18,
        foregroundColor: { red: 1, green: 0, blue: 0 },
      },
    });
  });

  it("refuses a one-column tab, where a heading could never be found again", async () => {
    // Sheets rejects a single-cell merge, so on a one-column tab this would
    // write text carrying NO merge — and the merge is the only thing that makes
    // a heading a heading. It would be invisible to every heading action
    // forever, and find_rows would hand it back as data. Fail instead of
    // leaving that behind.
    mockReadWithGrid([["Only"], ["a"]], { title: "Grouped" });

    await expect(run(heading)).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("clears the blankRowAbove separator in the SAME format call", async () => {
    mockReadWithGrid(table);

    const result = await run({ ...heading, blankRowAbove: true });

    // Row 5 is skipped (left empty), the heading lands on row 6.
    expect(writtenRange(0).range).toBe("'Grouped'!A6:ZZ6");

    // One batchUpdate carries both: the heading's style + merge, and the
    // separator (sheet row 5 → grid row 4) forced white.
    const requests = formatRequests(1);
    expect(requests).toHaveLength(3);
    expect(requests[2].repeatCell?.range).toEqual({
      sheetId: 77,
      startRowIndex: 4,
      endRowIndex: 5,
      startColumnIndex: 0,
      endColumnIndex: 3,
    });
    expect(requests[2].repeatCell?.fields).toBe(
      "userEnteredFormat.backgroundColor",
    );
    expect(result.GOOGLE_SHEETS_ACTION_1.rowIndex).toBe(6);
  });

  it("refuses to merge a blank band when the text renders empty", async () => {
    mockReadWithGrid(table);

    // The template is non-empty (so the config schema passes), but the value it
    // reads is missing — an unlabelled merged row would hide that.
    await expect(
      run({ ...heading, headingText: "@<AI_TEXT_1.output>@" }, {}),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("refuses a tab with no header row (nothing to merge across)", async () => {
    mockReadWithGrid([]);

    await expect(run(heading)).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("places a heading under a matched group and styles it there", async () => {
    mockReadWithGrid(table);

    // Globex sits MID-table (data row 1 → sheet row 3), so room has to be made
    // — unlike a group that already ends at the bottom, which just writes the
    // next free row.
    const result = await run({
      ...heading,
      position: "under_group",
      conditions: [
        { column: "Service Buyer", operator: "equals", value: "Globex" },
      ],
    });

    // Data row 1 → grid row 2, so the slot under it is grid row 3.
    expect(postBody(0).requests).toEqual([
      {
        insertDimension: {
          range: { sheetId: 77, dimension: "ROWS", startIndex: 3, endIndex: 4 },
          inheritFromBefore: true,
        },
      },
    ]);
    expect(writtenRange(1).range).toBe("'Grouped'!A4:ZZ4");
    expect(writtenRange(1).values).toEqual([["Invoices — March"]]);

    // The insert inherited Globex's banding — the style pass overrides it.
    // Sheet row 4 → grid row 3.
    const requests = formatRequests(2);
    expect(requests[0].repeatCell?.range.startRowIndex).toBe(3);
    expect(requests[1].mergeCells?.mergeType).toBe("MERGE_ALL");

    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.insertedUnderGroup).toBe(true);
    expect(out.matchCount).toBe(1);
    expect(out.headingText).toBe("Invoices — March");
    expect(out.rowIndex).toBe(4);
  });

  it("resolves @<anchorRow.…>@ in the heading text, per anchor", async () => {
    mockReadWithGrid(table);

    const outcome = (await run({
      ...heading,
      position: "under_each",
      headingText: "@<anchorRow.Job No>@ — follow-up",
      conditions: matchAcme,
    })) as unknown as FanOutOutcome;

    // One heading under EACH Acme row, each naming the row it sits under.
    expect(postBody(1).data).toEqual([
      { range: "'Grouped'!A3:ZZ3", values: [["0001 — follow-up"]] },
      { range: "'Grouped'!A6:ZZ6", values: [["0003 — follow-up"]] },
    ]);

    // A heading item carries its TEXT, not a header-keyed row.
    expect(isFanOut(outcome)).toBe(true);
    expect(outcome.items).toEqual([
      {
        headingText: "0001 — follow-up",
        rowIndex: 3,
        anchorRow: {
          "Service Buyer": "Acme",
          "Job No": "0001",
          Status: "Open",
        },
      },
      {
        headingText: "0003 — follow-up",
        rowIndex: 6,
        anchorRow: {
          "Service Buyer": "Acme",
          "Job No": "0003",
          Status: "Open",
        },
      },
    ]);

    const summary = outcome.context.GOOGLE_SHEETS_ACTION_1 as Record<
      string,
      unknown
    >;
    expect(summary.fannedOut).toBe(2);
    expect(summary.insertedRows).toEqual([
      { heading: "0001 — follow-up" },
      { heading: "0003 — follow-up" },
    ]);
    expect(summary.insertedRowIndexes).toEqual([3, 6]);
  });

  it("a fan-out CHILD reshapes its seed and writes nothing", async () => {
    mockReadWithGrid(table);

    const result = await run(
      { ...heading, position: "under_each", conditions: matchAcme },
      {
        GOOGLE_SHEETS_ACTION_1: {
          __fanOut: true,
          index: 2,
          total: 2,
          item: {
            headingText: "0003 — follow-up",
            rowIndex: 6,
            anchorRow: { "Job No": "0003" },
          },
        },
      },
    );

    // The parent already inserted every heading — a child must not insert again.
    expect(kyPostMock).not.toHaveBeenCalled();
    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.headingText).toBe("0003 — follow-up");
    expect(out.rowIndex).toBe(6);
    expect(out.matchCount).toBe(1);
    expect(out.rowByHeader).toBeUndefined();
  });

  it("refuses a non-bottom heading with no filter (it would head the whole tab)", async () => {
    mockReadWithGrid(table);

    await expect(
      run({ ...heading, position: "under_group", conditions: [] }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });
});

describe("googleSheetsActionExecutor — headings vs the reading actions", () => {
  // A tab whose FIRST column is "Job No." with an "Acme" HEADING among the data.
  // A merged heading keeps its text in the top-left cell, so that is exactly how
  // the values API returns the row.
  const withHeading = [
    ["Job No.", "Name", "Status"],
    ["0001", "Widget", "Open"], // data row 0 → sheet row 2
    ["Acme"], //                   data row 1 → sheet row 3  ← the heading
    ["0002", "Gadget", "Open"], // data row 2 → sheet row 4
    ["Acme", "Gizmo", "Open"], //  data row 3 → sheet row 5  ← REAL data, same text
  ];

  /**
   * Answers the values read AND the metadata read, with the heading's merge
   * declared — grid row 2 (data row 1), anchored at column A, one row tall.
   */
  function mockWithMerge(values: unknown[][], merges: unknown[]) {
    kyGetMock.mockImplementation((url: string) => ({
      json: async () =>
        url.includes("/values/")
          ? { values }
          : {
              sheets: [
                {
                  properties: {
                    sheetId: 77,
                    title: "Jobs",
                    gridProperties: { rowCount: 1000 },
                  },
                  merges,
                },
              ],
            },
    }));
  }

  const headingMerge = [
    {
      startRowIndex: 2,
      endRowIndex: 3,
      startColumnIndex: 0,
      endColumnIndex: 3,
    },
  ];

  const findAcme = {
    action: "find_rows",
    spreadsheetId: "s",
    sheetName: "Jobs",
    conditions: [{ column: "Job No.", operator: "equals", value: "Acme" }],
  };

  it("find_rows does NOT return a heading whose text matches the filter", async () => {
    mockWithMerge(withHeading, headingMerge);

    const out = ctx(await run(findAcme)).GOOGLE_SHEETS_ACTION_1;

    // Two rows hold "Acme" in the first column — the heading (row 3) and a real
    // data row (row 5). Only the real one comes back.
    expect(out.matchCount).toBe(1);
    // Output keys are sanitized headers, so "Job No." loses its dot.
    expect(out.firstRow).toEqual({
      "Job No": "Acme",
      Name: "Gizmo",
      Status: "Open",
    });
  });

  it("keeps a DATA row that merely looks like a heading (no merge on it)", async () => {
    // Same tab, but the sheet reports NO merges — so row 3 is just a sparse data
    // row, and hiding it would be data loss. This is why the merge ranges decide,
    // not the row's shape.
    mockWithMerge(withHeading, []);

    const out = ctx(await run(findAcme)).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(2);
  });

  it("excludes a heading whose row carries stray content in another column", async () => {
    // The shape a discarded optimisation used to mis-read: a genuine merged
    // heading that also holds a leftover value, so "first column filled, rest
    // empty" is false. Only the MERGE decides, so it is still excluded.
    mockWithMerge(
      [
        ["Job No.", "Name", "Status"],
        ["0001", "Widget", "Open"],
        ["Acme", "", "leftover"], // merged heading + stray cell
      ],
      [
        {
          startRowIndex: 2,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
      ],
    );

    const out = ctx(await run(findAcme)).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(0);
  });

  it("update_row will not overwrite a heading by default", async () => {
    mockWithMerge(withHeading, headingMerge);

    const out = ctx(
      await run({
        action: "update_row",
        spreadsheetId: "s",
        sheetName: "Jobs",
        conditions: [{ column: "Job No.", operator: "equals", value: "Acme" }],
        columnMappings: { Status: "Closed" },
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    // Two rows read "Acme" in the first column; only the real data row (sheet
    // row 5) is written. The heading is left alone.
    expect(out.matchCount).toBe(1);
    expect(out.rowIndex).toBe(5);
  });

  it("update_row CAN target a heading when scoped to headings", async () => {
    mockWithMerge(withHeading, headingMerge);

    const out = ctx(
      await run({
        action: "update_row",
        spreadsheetId: "s",
        sheetName: "Jobs",
        rowScope: "headings",
        conditions: [{ column: "Job No.", operator: "equals", value: "Acme" }],
        columnMappings: { "Job No.": "Renamed" },
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    // Now the opposite row: the heading at sheet row 3, not the data row.
    expect(out.matchCount).toBe(1);
    expect(out.rowIndex).toBe(3);
  });

  it("rowScope 'all' restores the pre-heading behaviour", async () => {
    mockWithMerge(withHeading, headingMerge);

    const out = ctx(
      await run({
        action: "update_row",
        spreadsheetId: "s",
        sheetName: "Jobs",
        rowScope: "all",
        onMultipleMatches: "each",
        conditions: [{ column: "Job No.", operator: "equals", value: "Acme" }],
        columnMappings: { Status: "Closed" },
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    expect(out.matchCount).toBe(2);
  });

  it("find_heading ignores an onMultipleMatches inherited from find_rows", async () => {
    // Switching a find_rows node to find_heading leaves "each" in its data, and
    // the heading dialog shows no control to clear it. find_heading never fans
    // out, so it must not hit the fan-out cap on an unreachable setting.
    mockWithMerge(withHeading, headingMerge);

    const out = ctx(
      await run({
        action: "find_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        onMultipleMatches: "each",
        maxFanOutItems: 1,
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    expect(out.matchCount).toBe(1);
  });

  it("find_heading returns ONLY the heading, and reports where it is", async () => {
    mockWithMerge(withHeading, headingMerge);

    const outcome = await run({
      action: "find_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingFilter: { operator: "equals", value: "Acme" },
    });

    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(1);
    expect(out.headings).toEqual(["Acme"]);
    expect(out.headingRowIndexes).toEqual([3]);
    expect(out.firstHeading).toBe("Acme");
    expect(out.rowIndex).toBe(3);
    // The real "Acme" data row is not a heading, so it is absent.
    expect(outputs(outcome)).toContain("found");
  });

  it("find_heading matches case-insensitively", async () => {
    mockWithMerge(withHeading, headingMerge);

    const out = ctx(
      await run({
        action: "find_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingFilter: { operator: "equals", value: "acme" },
      }),
    ).GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(1);
  });

  it("find_heading with no value lists every heading on the tab", async () => {
    mockWithMerge(
      [
        ["Job No.", "Name", "Status"],
        ["March"], // data row 0 → sheet row 2  ← heading
        ["0001", "Widget", "Open"],
        ["April"], // data row 2 → sheet row 4  ← heading
      ],
      [
        {
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        {
          startRowIndex: 3,
          endRowIndex: 4,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
      ],
    );

    const out = ctx(
      await run({
        action: "find_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
      }),
    ).GOOGLE_SHEETS_ACTION_1;
    expect(out.headings).toEqual(["March", "April"]);
    expect(out.headingRowIndexes).toEqual([2, 4]);
  });

  it("finds a heading even when its row has stray content in another column", async () => {
    // The shape heuristic ("first column filled, rest empty") is only an
    // optimisation for find_rows. If it were allowed to gate find_heading's
    // merge lookup, this row — a genuine MERGED heading that happens to carry a
    // leftover value further along — would come back as a silent zero result.
    mockWithMerge(
      [
        ["Job No.", "Name", "Status"],
        ["0001", "Widget", "Open"],
        ["Acme", "", "leftover"], // merged heading + stray cell
      ],
      [
        {
          startRowIndex: 2,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
      ],
    );

    const out = ctx(
      await run({
        action: "find_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingFilter: { operator: "equals", value: "Acme" },
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    expect(out.matchCount).toBe(1);
    expect(out.headingRowIndexes).toEqual([3]);
  });

  it("reports how many headings the tab has, so a zero result is diagnosable", async () => {
    // No merges at all — the tab has no headings, which is a different problem
    // from "your search text matched nothing".
    mockWithMerge(withHeading, []);

    const out = ctx(
      await run({
        action: "find_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingFilter: { operator: "equals", value: "Acme" },
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    expect(out.matchCount).toBe(0);
    expect(out.headingsOnTab).toBe(0);
  });

  it("update_heading renames the heading, writing ONE cell not a range", async () => {
    mockWithMerge(withHeading, headingMerge);

    const outcome = await run({
      action: "update_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingFilter: { operator: "equals", value: "Acme" },
      headingText: "Acme — Q2",
    });

    // A single-cell range (A3), never A3:ZZ3 — the anchor is the only cell a
    // merge actually has, so this never writes across the merged band.
    expect(writtenRange(0).range).toBe("'Jobs'!A3");
    expect(writtenRange(0).values).toEqual([["Acme — Q2"]]);
    // RAW: a heading is a label, so Sheets must not re-parse it.
    expect(postBody(0).valueInputOption).toBe("RAW");
    // Text only — no restyle was asked for, so no format batchUpdate.
    expect(kyPostMock).toHaveBeenCalledTimes(1);

    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.matched).toBe(true);
    expect(out.previousHeading).toBe("Acme");
    expect(out.headingText).toBe("Acme — Q2");
    expect(out.rowIndex).toBe(3);
    expect(outputs(outcome)).toContain("updated");
  });

  it("update_heading never touches a DATA row of the same text", async () => {
    mockWithMerge(withHeading, headingMerge);

    // Row 5 is real data reading "Acme"; only the heading at row 3 is rewritten.
    await run({
      action: "update_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingFilter: { operator: "equals", value: "Acme" },
      headingText: "Renamed",
    });

    expect(writtenRange(0).range).toBe("'Jobs'!A3");
  });

  it("update_heading can restyle without changing the text", async () => {
    mockWithMerge(withHeading, headingMerge);

    const out = ctx(
      await run({
        action: "update_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingFilter: { operator: "equals", value: "Acme" },
        restyleHeading: true,
        // Required: restyling with no saved style would silently reset the
        // heading to this app's defaults, so the executor refuses it.
        headingFormat: { bold: true, fontSize: 14 },
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    // No value write at all — only the format batchUpdate.
    expect(kyPostMock).toHaveBeenCalledTimes(1);
    expect(postBody(0).url).toContain(":batchUpdate");
    expect(postBody(0).url).not.toContain("values:batchUpdate");
    expect(out.headingText).toBe("Acme");
    expect(out.previousHeading).toBe("Acme");
    expect(out.restyled).toBe(true);
  });

  it("re-merges a restyled heading at ITS width, not today's header count", async () => {
    // The heading was merged when the tab had 3 columns; a 4th has since been
    // added. Re-merging over A:D would partially overlap the existing A:C merge
    // — Sheets rejects that, and it would fail AFTER the text write landed.
    mockWithMerge(
      [["Job No.", "Name", "Status", "Added Later"], ["Acme"]],
      [
        {
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 3, // still only 3 wide
        },
      ],
    );

    await run({
      action: "update_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingText: "Acme — Q2",
      restyleHeading: true,
      headingFormat: { bold: true },
    });

    const format = (postBody(1).requests ?? []) as Array<{
      repeatCell?: { range: { endColumnIndex: number } };
      mergeCells?: { range: { endColumnIndex: number } };
    }>;
    // 3, the merge's real width — NOT 4, the tab's current header count.
    expect(format[0].repeatCell?.range.endColumnIndex).toBe(3);
    expect(format[1].mergeCells?.range.endColumnIndex).toBe(3);
  });

  it("refuses to restyle when the node has no saved style", async () => {
    // Restyling re-applies `headingFormat`; with none it would resolve to the
    // app defaults and silently overwrite whatever styling the heading had.
    mockWithMerge(withHeading, headingMerge);

    await expect(
      run({
        action: "update_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingFilter: { operator: "equals", value: "Acme" },
        restyleHeading: true,
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("refuses update_heading on a tab with no header row", async () => {
    // Otherwise columnCount is 0, styleHeadingRows early-returns, and the run
    // reports a restyle that never happened.
    mockWithMerge([], []);

    await expect(
      run({
        action: "update_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingText: "Anything",
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("reports merged rows that do NOT qualify, so a dead end is diagnosable", async () => {
    // Two merges that both look like headings to a human and neither of which
    // qualifies: one spans two rows, one starts at column B. Without this count
    // the run can only say "no headings", which reads as a bug to someone
    // staring at a merged row.
    mockWithMerge(withHeading, [
      {
        startRowIndex: 1,
        endRowIndex: 3, // two rows tall
        startColumnIndex: 0,
        endColumnIndex: 3,
      },
      {
        startRowIndex: 4,
        endRowIndex: 5,
        startColumnIndex: 1, // starts at column B
        endColumnIndex: 3,
      },
    ]);

    const out = ctx(
      await run({
        action: "find_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    expect(out.headingsOnTab).toBe(0);
    expect(out.nearMisses).toBe(2);
  });

  it("color_heading reads the tab's metadata ONCE, not twice", async () => {
    mockWithMerge(withHeading, headingMerge);

    await run({
      action: "color_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingColor: "#fef3c7",
    });

    // One values read + one metadata read. The metadata response already
    // carries `sheetId`, so fetching it again just to address the tab would
    // double the cost of the expensive `includeMerges` call.
    const metadataReads = kyGetMock.mock.calls.filter(
      ([url]) => !String(url).includes("/values/"),
    );
    expect(metadataReads).toHaveLength(1);
  });

  it("update_heading routes No-match and reports the tab's heading count", async () => {
    mockWithMerge(withHeading, []);

    const outcome = await run({
      action: "update_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingFilter: { operator: "equals", value: "Acme" },
      headingText: "Renamed",
    });

    expect(outputs(outcome)).toEqual(["no_match"]);
    expect(kyPostMock).not.toHaveBeenCalled();
    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.matched).toBe(false);
    expect(out.headingsOnTab).toBe(0);
  });

  it("color_heading paints only the heading, across its merged band", async () => {
    mockWithMerge(withHeading, headingMerge);

    const outcome = await run({
      action: "color_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingFilter: { operator: "equals", value: "Acme" },
      headingColor: "#fef3c7",
    });

    const requests = (postBody(0).requests ?? []) as Array<{
      repeatCell: {
        range: Record<string, number>;
        cell: { userEnteredFormat: { backgroundColor: unknown } };
      };
    }>;
    // ONE row: data row 1 → grid row 2, across the 3-column header band. The
    // real "Acme" data row at index 3 is untouched.
    expect(requests).toHaveLength(1);
    expect(requests[0].repeatCell.range).toEqual({
      sheetId: 77,
      startRowIndex: 2,
      endRowIndex: 3,
      startColumnIndex: 0,
      endColumnIndex: 3,
    });
    expect(
      requests[0].repeatCell.cell.userEnteredFormat.backgroundColor,
    ).toEqual({ red: 254 / 255, green: 243 / 255, blue: 199 / 255 });

    const out = ctx(outcome).GOOGLE_SHEETS_ACTION_1;
    expect(out.coloredCount).toBe(1);
    expect(out.headings).toEqual(["Acme"]);
    expect(out.headingRowIndexes).toEqual([3]);
    expect(out.color).toBe("#fef3c7");
    expect(outputs(outcome)).toContain("colored");
  });

  it("color_heading paints the heading's OWN merge width, not the tab's wider header", async () => {
    // The "Acme" heading is merged only 2 columns wide, though the tab now has
    // 3 columns. The paint band must match the merge (endColumnIndex 2), not the
    // header count (3): painting to 3 would colour a cell outside the merge and
    // disagree with update_heading's restyle, which sizes the row by this same
    // merged width.
    const narrowMerge = [
      {
        startRowIndex: 2,
        endRowIndex: 3,
        startColumnIndex: 0,
        endColumnIndex: 2,
      },
    ];
    mockWithMerge(withHeading, narrowMerge);

    await run({
      action: "color_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingFilter: { operator: "equals", value: "Acme" },
      headingColor: "#fef3c7",
    });

    const requests = (postBody(0).requests ?? []) as Array<{
      repeatCell: { range: Record<string, number> };
    }>;
    expect(requests).toHaveLength(1);
    expect(requests[0].repeatCell.range).toEqual({
      sheetId: 77,
      startRowIndex: 2,
      endRowIndex: 3,
      startColumnIndex: 0,
      endColumnIndex: 2,
    });
  });

  it("color_heading with no filter paints every heading", async () => {
    mockWithMerge(
      [
        ["Job No.", "Name", "Status"],
        ["March"],
        ["0001", "Widget", "Open"],
        ["April"],
      ],
      [
        {
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        {
          startRowIndex: 3,
          endRowIndex: 4,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
      ],
    );

    const out = ctx(
      await run({
        action: "color_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingColor: "#dbeafe",
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    expect(out.coloredCount).toBe(2);
    expect(out.headings).toEqual(["March", "April"]);
    expect(out.headingRowIndexes).toEqual([2, 4]);
  });

  it("color_heading routes No-match and writes nothing when none match", async () => {
    mockWithMerge(withHeading, headingMerge);

    const outcome = await run({
      action: "color_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingFilter: { operator: "equals", value: "Globex" },
      headingColor: "#dbeafe",
    });

    expect(outputs(outcome)).toEqual(["no_match"]);
    expect(kyPostMock).not.toHaveBeenCalled();
    expect(ctx(outcome).GOOGLE_SHEETS_ACTION_1.coloredCount).toBe(0);
  });

  const threeHeadings = [
    ["Job No.", "Name", "Status"],
    ["March"], // data row 0 → sheet row 2
    ["0001", "Widget", "Open"],
    ["April"], // data row 2 → sheet row 4
    ["May"], //  data row 3 → sheet row 5
  ];
  const threeMerges = [0, 2, 3].map((r) => ({
    startRowIndex: r + 1,
    endRowIndex: r + 2,
    startColumnIndex: 0,
    endColumnIndex: 3,
  }));

  it("find_heading 'first' returns the topmost; 'last' the bottom-most", async () => {
    mockWithMerge(threeHeadings, threeMerges);
    const first = ctx(
      await run({
        action: "find_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        onMultipleHeadings: "first",
      }),
    ).GOOGLE_SHEETS_ACTION_1;
    expect(first.headings).toEqual(["March"]);
    expect(first.matchCount).toBe(3);
    expect(first.actedCount).toBe(1);

    mockWithMerge(threeHeadings, threeMerges);
    const last = ctx(
      await run({
        action: "find_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        onMultipleHeadings: "last",
      }),
    ).GOOGLE_SHEETS_ACTION_1;
    expect(last.headings).toEqual(["May"]);
    expect(last.headingRowIndexes).toEqual([5]);
  });

  it("find_heading 'each' fans out one run per heading", async () => {
    mockWithMerge(threeHeadings, threeMerges);
    const outcome = await run({
      action: "find_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      onMultipleHeadings: "each",
    });

    expect(isFanOut(outcome)).toBe(true);
    const fan = outcome as unknown as FanOutOutcome;
    // Each item carries its heading plus the tab-level facts a child must be
    // able to report without an API call.
    expect(fan.items).toEqual([
      { heading: "March", rowIndex: 2, headingsOnTab: 3, nearMisses: 0 },
      { heading: "April", rowIndex: 4, headingsOnTab: 3, nearMisses: 0 },
      { heading: "May", rowIndex: 5, headingsOnTab: 3, nearMisses: 0 },
    ]);
    const summary = fan.context.GOOGLE_SHEETS_ACTION_1 as Record<
      string,
      unknown
    >;
    expect(summary.fannedOut).toBe(3);
    // The fan-out fuel must not survive into the recorded output.
    expect(summary.items).toBeUndefined();
  });

  it("a find_heading 'each' CHILD reshapes its seed and reads nothing", async () => {
    const result = await run(
      {
        action: "find_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        onMultipleHeadings: "each",
      },
      {
        GOOGLE_SHEETS_ACTION_1: {
          __fanOut: true,
          index: 2,
          total: 3,
          item: {
            heading: "April",
            rowIndex: 4,
            headingsOnTab: 3,
            nearMisses: 0,
          },
        },
      },
    );

    expect(kyGetMock).not.toHaveBeenCalled();
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.firstHeading).toBe("April");
    expect(out.headings).toEqual(["April"]);
    expect(out.rowIndex).toBe(4);
    expect(out.matchCount).toBe(1);
    // Tab-level facts resolve in the child, so a downstream reference to them
    // is not silently empty in "each" mode.
    expect(out.actedCount).toBe(1);
    expect(out.headingsOnTab).toBe(3);
  });

  it("color_heading 'first' paints only the topmost of several matches", async () => {
    mockWithMerge(threeHeadings, threeMerges);
    const out = ctx(
      await run({
        action: "color_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingColor: "#fef3c7",
        onMultipleHeadings: "first",
      }),
    ).GOOGLE_SHEETS_ACTION_1;

    const requests = (postBody(0).requests ?? []) as Array<{
      repeatCell: { range: { startRowIndex: number } };
    }>;
    // Only March's row (data row 0 → grid row 1) is painted.
    expect(requests).toHaveLength(1);
    expect(requests[0].repeatCell.range.startRowIndex).toBe(1);
    expect(out.matchCount).toBe(3);
    expect(out.coloredCount).toBe(1);
  });

  it("color_heading 'each' paints all AND fans out one run per heading", async () => {
    mockWithMerge(threeHeadings, threeMerges);
    const outcome = await run({
      action: "color_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingColor: "#fef3c7",
      onMultipleHeadings: "each",
    });

    // All three painted in the single batchUpdate…
    const requests = (postBody(0).requests ?? []) as unknown[];
    expect(requests).toHaveLength(3);
    // …and a fan-out afterwards.
    expect(isFanOut(outcome)).toBe(true);
    const fan = outcome as unknown as FanOutOutcome;
    expect(fan.items).toHaveLength(3);
    expect(
      (fan.context.GOOGLE_SHEETS_ACTION_1 as Record<string, unknown>).fannedOut,
    ).toBe(3);
  });

  it("a color_heading 'each' CHILD reshapes its seed and paints nothing", async () => {
    const result = await run(
      {
        action: "color_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingColor: "#fef3c7",
        onMultipleHeadings: "each",
      },
      {
        GOOGLE_SHEETS_ACTION_1: {
          __fanOut: true,
          index: 1,
          total: 3,
          item: { heading: "March", rowIndex: 2 },
        },
      },
    );

    expect(kyPostMock).not.toHaveBeenCalled();
    const out = ctx(result).GOOGLE_SHEETS_ACTION_1;
    expect(out.coloredCount).toBe(1);
    expect(out.headings).toEqual(["March"]);
    expect(out.color).toBe("#fef3c7");
  });

  it("color_heading refuses a malformed color before writing", async () => {
    mockWithMerge(withHeading, headingMerge);

    await expect(
      run({
        action: "color_heading",
        spreadsheetId: "s",
        sheetName: "Jobs",
        headingColor: "not-a-color",
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(kyPostMock).not.toHaveBeenCalled();
  });

  it("find_heading routes Not-found when no heading matches", async () => {
    mockWithMerge(withHeading, headingMerge);

    const outcome = await run({
      action: "find_heading",
      spreadsheetId: "s",
      sheetName: "Jobs",
      headingFilter: { operator: "equals", value: "Globex" },
    });

    expect(outputs(outcome)).toEqual(["notfound"]);
    expect(ctx(outcome).GOOGLE_SHEETS_ACTION_1.matchCount).toBe(0);
  });
});
