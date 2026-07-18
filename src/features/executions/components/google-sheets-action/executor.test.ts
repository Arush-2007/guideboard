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
function mockRead(values: unknown[][]) {
  kyGetMock.mockReturnValue({ json: async () => ({ values }) });
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

    expect(kyPostMock).toHaveBeenCalledOnce();
    const w = writtenRange(0);
    expect(w.range).toBe("'Master'!A3:ZZ3");
    expect(w.values).toEqual([["", ""]]);

    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.appendedRows).toBe(1);
    expect(out.rowByHeader).toEqual({ "Job No": "", Name: "" });
    expect(publishedStatuses).toContain("success");
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
