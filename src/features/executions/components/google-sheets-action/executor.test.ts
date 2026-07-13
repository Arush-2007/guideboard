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
vi.mock("ky", () => ({
  default: { get: kyGetMock, post: kyPostMock },
  HTTPError: FakeHTTPError,
}));

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
  type NodeExecutorParams,
} from "@/features/executions/types";
import { encodeCustomFeatureToken } from "@/lib/custom-feature-token";
import { googleSheetsActionExecutor } from "./executor";

const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
} as unknown as NodeExecutorParams["step"];

let publishedStatuses: string[];
const publish = (async (msg: { status: string }) => {
  publishedStatuses.push(msg.status);
}) as unknown as NodeExecutorParams["publish"];

// readSheetTable does `ky.get(url).json<T>()` — return the values payload.
function mockRead(values: unknown[][]) {
  kyGetMock.mockReturnValue({ json: async () => ({ values }) });
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

const serialToken = encodeCustomFeatureToken("serialNumber", {
  start: 1,
  pad: 4,
});

beforeEach(() => {
  vi.clearAllMocks();
  publishedStatuses = [];
  refreshTokenMock.mockResolvedValue("token-123");
  kyPostMock.mockResolvedValue({});
});

describe("googleSheetsActionExecutor — append with mappings", () => {
  it("appends a mapped row and emits apostrophe-free, dot-stripped rowByHeader", async () => {
    mockRead([
      ["Job No.", "Name"],
      ["0001", "X"],
    ]);

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

    expect(kyPostMock).toHaveBeenCalledOnce();
    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.appendedRows).toBe(1);
    // serialAsText → '0002 written; rowByHeader strips the apostrophe + dot.
    expect(out.row).toEqual(["'0002", "Ada"]);
    expect(out.rowByHeader).toEqual({ "Job No": "0002", Name: "Ada" });
    expect(publishedStatuses).toContain("success");
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

    const out = result.GOOGLE_SHEETS_ACTION_1;
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

    const out = result.GOOGLE_SHEETS_ACTION_1;
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

    const out = result.GOOGLE_SHEETS_ACTION_1;
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
    expect(result.GOOGLE_SHEETS_ACTION_1.matchCount).toBe(1);
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

    const out = result.GOOGLE_SHEETS_ACTION_1;
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

  it("'each' with zero matches fans out zero children", async () => {
    mockRead([
      ["Name", "Buyer"],
      ["Ada", "Globex"],
    ]);

    const outcome = (await run({
      action: "find_rows",
      spreadsheetId: "s",
      sheetName: "Ledger",
      conditions: [{ column: "Buyer", operator: "equals", value: "Acme" }],
      onMultipleMatches: "each",
    })) as unknown as FanOutOutcome;

    expect(isFanOut(outcome)).toBe(true);
    expect(outcome.items).toEqual([]);
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
    const out = result.GOOGLE_SHEETS_ACTION_1 as Record<string, unknown>;
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
