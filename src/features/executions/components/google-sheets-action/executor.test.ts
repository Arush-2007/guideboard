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

import type { NodeExecutorParams } from "@/features/executions/types";
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
  it("returns only selected columns, full matchCount, and unique columnValues", async () => {
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
      selectedColumns: ["Name", "Buyer"],
    });

    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(2); // Ada (10) and Cy (5)
    expect(out.columns).toEqual(["Name", "Buyer"]);
    expect(out.rows).toEqual([
      { Name: "Ada", Buyer: "Acme" },
      { Name: "Cy", Buyer: "Globex" },
    ]);
    expect(out.columnValues).toEqual({
      Name: JSON.stringify(["Ada", "Cy"]),
      Buyer: JSON.stringify(["Acme", "Globex"]),
    });
    // firstRow = the first matched row's selected columns (single values).
    expect(out.firstRow).toEqual({ Name: "Ada", Buyer: "Acme" });
    expect(kyPostMock).not.toHaveBeenCalled();
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
      selectedColumns: ["Name"],
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
        selectedColumns: ["Name"],
      },
      { ctx: { buyers: JSON.stringify(["Acme"]) } },
    );

    const out = result.GOOGLE_SHEETS_ACTION_1;
    expect(out.matchCount).toBe(2);
    expect(out.rows).toEqual([{ Name: "Ada" }, { Name: "Cy" }]);
  });
});
