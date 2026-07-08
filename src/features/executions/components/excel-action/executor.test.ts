import { NonRetriableError, RetryAfterError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake ky with URL-routed mocks. FakeHTTPError mirrors ky's HTTPError shape
// (instanceof check + response.status/headers/json) so the executor's Graph
// error mapping is what's under test.
const { kyGetMock, kyPostMock, kyPatchMock, FakeHTTPError } = vi.hoisted(() => {
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
  return {
    kyGetMock: vi.fn(),
    kyPostMock: vi.fn(),
    kyPatchMock: vi.fn(),
    FakeHTTPError,
  };
});
vi.mock("ky", () => ({
  default: { get: kyGetMock, post: kyPostMock, patch: kyPatchMock },
  HTTPError: FakeHTTPError,
}));

const { getFirstTableMock, getColumnsMock } = vi.hoisted(() => ({
  getFirstTableMock: vi.fn(),
  getColumnsMock: vi.fn(),
}));
vi.mock("@/lib/ms-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ms-graph")>();
  return {
    ...actual,
    getFirstTableOnWorksheet: getFirstTableMock,
    getTableColumnNames: getColumnsMock,
  };
});

const { refreshTokenMock } = vi.hoisted(() => ({
  refreshTokenMock: vi.fn(),
}));
vi.mock("@/lib/microsoft-token", () => ({
  refreshMicrosoftTokenIfNeeded: refreshTokenMock,
}));

// Make `.status(payload)` return the payload so `publish` receives it verbatim.
vi.mock("@/inngest/channels/node-status", () => ({
  nodeStatusChannel: () => ({ status: (payload: unknown) => payload }),
}));

import type { NodeExecutorParams } from "@/features/executions/types";
import { coerceCellValue, excelActionExecutor } from "./executor";

const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
} as unknown as NodeExecutorParams["step"];

let publishedStatuses: string[];
const publish = (async (msg: { status: string }) => {
  publishedStatuses.push(msg.status);
}) as unknown as NodeExecutorParams["publish"];

type ExcelResult = Record<
  string,
  {
    operation: string;
    tableName: string;
    matched: boolean;
    matchedRows?: number;
    rowIndex?: number;
    row: unknown[];
  }
>;

const run = (
  data: Record<string, unknown>,
  context: Record<string, unknown> = {},
) =>
  excelActionExecutor({
    data,
    nodeId: "x1",
    outputKey: "EXCEL_ACTION_1",
    executionId: "exec_test",
    userId: "u1",
    context,
    step,
    publish,
  }) as Promise<ExcelResult>;

// A ky ResponsePromise stand-in: awaitable, .catch-able, and .json()-able.
const res = (value: unknown = {}) =>
  Object.assign(Promise.resolve(value), {
    json: () => Promise.resolve(value),
  });

beforeEach(() => {
  kyGetMock.mockReset();
  kyPostMock.mockReset();
  kyPatchMock.mockReset();
  getFirstTableMock.mockReset();
  getColumnsMock.mockReset();
  refreshTokenMock.mockReset();
  refreshTokenMock.mockResolvedValue("access-token");
  getFirstTableMock.mockResolvedValue({ id: "t1", name: "Jobs" });
  publishedStatuses = [];
});

describe("excelActionExecutor append_row", () => {
  it("appends a mapped row, autofilling the serial column and coercing numbers", async () => {
    getColumnsMock.mockResolvedValue(["S.No", "Customer", "Amount"]);
    kyGetMock.mockImplementation((url: string) => {
      if (url.includes("/dataBodyRange")) return res({ rowCount: 5 });
      throw new Error(`unexpected GET ${url}`);
    });
    kyPostMock.mockImplementation(() => res({}));

    const result = await run(
      {
        operation: "append_row",
        workbookId: "wb1",
        worksheetName: "Sheet1",
        columnMappings: { Customer: "@<form.name>@", Amount: "@<form.amt>@" },
      },
      { form: { name: "Ada", amt: "4200" } },
    );

    const addCall = kyPostMock.mock.calls.find(([url]) =>
      String(url).includes("/rows/add"),
    );
    expect(addCall).toBeDefined();
    expect(addCall?.[1]?.json).toEqual({ values: [[6, "Ada", 4200]] });
    expect(result.EXCEL_ACTION_1).toMatchObject({
      operation: "append_row",
      tableName: "Jobs",
      matched: false,
    });
    expect(publishedStatuses).toEqual(["loading", "success"]);
  });

  it("treats the blank placeholder row of an empty table as zero data rows", async () => {
    getColumnsMock.mockResolvedValue(["S.No", "Customer"]);
    kyGetMock.mockImplementation(
      (url: string, opts?: { searchParams?: Record<string, string> }) => {
        if (!String(url).includes("/dataBodyRange")) {
          throw new Error(`unexpected GET ${url}`);
        }
        if (opts?.searchParams?.$select === "rowCount")
          return res({ rowCount: 1 });
        return res({ values: [["", ""]] });
      },
    );
    kyPostMock.mockImplementation(() => res({}));

    await run({
      operation: "append_row",
      workbookId: "wb1",
      worksheetName: "Sheet1",
      columnMappings: { Customer: "Ada" },
    });

    const addCall = kyPostMock.mock.calls.find(([url]) =>
      String(url).includes("/rows/add"),
    );
    expect(addCall?.[1]?.json).toEqual({ values: [[1, "Ada"]] });
  });

  it("skips the row-count fetch when no unmapped serial column exists", async () => {
    getColumnsMock.mockResolvedValue(["Customer", "Amount"]);
    kyPostMock.mockImplementation(() => res({}));

    await run({
      operation: "append_row",
      workbookId: "wb1",
      worksheetName: "Sheet1",
      columnMappings: { Customer: "Ada" },
    });

    expect(kyGetMock).not.toHaveBeenCalled();
  });
});

describe("excelActionExecutor upsert_by_key", () => {
  const upsertData = {
    operation: "upsert_by_key",
    workbookId: "wb1",
    worksheetName: "Pending",
    columnMappings: { Estimated: "@<amt>@", Pending: "@<amt>@" },
    columnModes: { Estimated: "add", Pending: "add" },
    keyColumn: "Service Buyer",
    keyValue: "@<buyer>@",
  };

  it("adds to the matched row's numbers inside a workbook session", async () => {
    getColumnsMock.mockResolvedValue(["Service Buyer", "Estimated", "Pending"]);
    kyPostMock.mockImplementation((url: string) => {
      if (String(url).includes("/createSession")) return res({ id: "sess1" });
      return res({});
    });
    kyGetMock.mockImplementation((url: string) => {
      if (String(url).includes("/columns(")) {
        return res({ values: [["Govt PWD"], ["Private"]] });
      }
      if (String(url).includes("/rows/itemAt(index=0)")) {
        return res({ values: [["Govt PWD", 3000, 2500]] });
      }
      throw new Error(`unexpected GET ${url}`);
    });
    kyPatchMock.mockImplementation(() => res({}));

    // key match is trimmed + case-insensitive
    const result = await run(upsertData, { amt: "1500", buyer: "GOVT PWD" });

    const patchCall = kyPatchMock.mock.calls[0];
    expect(String(patchCall[0])).toContain("/rows/itemAt(index=0)");
    expect(patchCall[1]?.json).toEqual({ values: [[null, 4500, 4000]] });
    expect(patchCall[1]?.headers["workbook-session-id"]).toBe("sess1");
    expect(result.EXCEL_ACTION_1).toMatchObject({
      matched: true,
      matchedRows: 1,
      rowIndex: 0,
    });
    expect(
      kyPostMock.mock.calls.some(([url]) =>
        String(url).includes("/closeSession"),
      ),
    ).toBe(true);
    expect(publishedStatuses).toEqual(["loading", "success"]);
  });

  it("inserts a new row carrying the key when no row matches", async () => {
    getColumnsMock.mockResolvedValue(["Service Buyer", "Estimated"]);
    kyPostMock.mockImplementation((url: string) => {
      if (String(url).includes("/createSession")) return res({ id: "sess1" });
      return res({});
    });
    kyGetMock.mockImplementation((url: string) => {
      if (String(url).includes("/columns(")) {
        return res({ values: [["Someone Else"]] });
      }
      throw new Error(`unexpected GET ${url}`);
    });

    const result = await run(
      { ...upsertData, columnMappings: { Estimated: "500" }, columnModes: {} },
      { buyer: "Govt PWD" },
    );

    const addCall = kyPostMock.mock.calls.find(([url]) =>
      String(url).includes("/rows/add"),
    );
    // unmapped key column is backfilled with the key value
    expect(addCall?.[1]?.json).toEqual({ values: [["Govt PWD", 500]] });
    expect(result.EXCEL_ACTION_1).toMatchObject({
      matched: false,
      matchedRows: 0,
    });
    expect(kyPatchMock).not.toHaveBeenCalled();
  });

  it("fails without retry when an add-mode cell holds a non-numeric value", async () => {
    getColumnsMock.mockResolvedValue(["Service Buyer", "Estimated"]);
    kyPostMock.mockImplementation((url: string) => {
      if (String(url).includes("/createSession")) return res({ id: "sess1" });
      return res({});
    });
    kyGetMock.mockImplementation((url: string) => {
      if (String(url).includes("/columns("))
        return res({ values: [["Govt PWD"]] });
      if (String(url).includes("/rows/itemAt")) {
        return res({ values: [["Govt PWD", "not a number"]] });
      }
      throw new Error(`unexpected GET ${url}`);
    });

    await expect(
      run(
        {
          ...upsertData,
          columnMappings: { Estimated: "100" },
          columnModes: { Estimated: "add" },
        },
        { buyer: "Govt PWD" },
      ),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof NonRetriableError &&
        /"Estimated".*non-numeric/.test(e.message),
    );
    expect(publishedStatuses).toEqual(["loading", "error"]);
    // session still closed on failure
    expect(
      kyPostMock.mock.calls.some(([url]) =>
        String(url).includes("/closeSession"),
      ),
    ).toBe(true);
  });
});

describe("excelActionExecutor error mapping", () => {
  const appendData = {
    operation: "append_row",
    workbookId: "wb1",
    worksheetName: "Sheet1",
    columnMappings: { Customer: "Ada" },
  };

  it("rejects invalid config without retry", async () => {
    await expect(
      run({ operation: "append_row", worksheetName: "Sheet1" }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(publishedStatuses).toEqual(["loading", "error"]);
  });

  it("explains the missing-Table case without retry", async () => {
    getFirstTableMock.mockResolvedValue(null);

    await expect(run(appendData)).rejects.toSatisfy(
      (e) => e instanceof NonRetriableError && /Ctrl\+T/.test(e.message),
    );
    expect(publishedStatuses).toEqual(["loading", "error"]);
  });

  it("maps 404 to a non-retriable error with the Graph code", async () => {
    getColumnsMock.mockResolvedValue(["Customer"]);
    kyPostMock.mockImplementation(() => {
      throw new FakeHTTPError(404, {
        error: {
          code: "ItemNotFound",
          message: "The resource could not be found.",
        },
      });
    });

    await expect(run(appendData)).rejects.toSatisfy(
      (e) => e instanceof NonRetriableError && /ItemNotFound/.test(e.message),
    );
  });

  it("maps 423 (workbook locked) to RetryAfterError", async () => {
    getColumnsMock.mockResolvedValue(["Customer"]);
    kyPostMock.mockImplementation(() => {
      throw new FakeHTTPError(423, { error: { code: "resourceLocked" } });
    });

    await expect(run(appendData)).rejects.toBeInstanceOf(RetryAfterError);
    expect(publishedStatuses).toEqual(["loading", "error"]);
  });

  it("maps 429 to RetryAfterError honoring Retry-After", async () => {
    getColumnsMock.mockResolvedValue(["Customer"]);
    kyPostMock.mockImplementation(() => {
      throw new FakeHTTPError(429, {}, { "retry-after": "17" });
    });

    const error = await run(appendData).catch((e) => e);
    expect(error).toBeInstanceOf(RetryAfterError);
    // Inngest normalizes the "17s" time string internally — assert the header
    // value survived rather than the exact representation.
    expect(String((error as RetryAfterError).retryAfter)).toContain("17");
  });

  it("leaves 5xx retriable", async () => {
    getColumnsMock.mockResolvedValue(["Customer"]);
    kyPostMock.mockImplementation(() => {
      throw new FakeHTTPError(504, { error: { code: "GatewayTimeout" } });
    });

    const error = await run(appendData).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetriableError);
    expect(error).not.toBeInstanceOf(RetryAfterError);
  });

  it("treats a missing Microsoft credential as non-retriable", async () => {
    refreshTokenMock.mockRejectedValue(
      new Error("No Microsoft credential found."),
    );

    await expect(run(appendData)).rejects.toBeInstanceOf(NonRetriableError);
  });
});

describe("coerceCellValue", () => {
  it("converts plain numerics and preserves leading-zero ids as text", () => {
    expect(coerceCellValue("4200")).toBe(4200);
    expect(coerceCellValue("-3.5")).toBe(-3.5);
    expect(coerceCellValue("0")).toBe(0);
    expect(coerceCellValue("0001")).toBe("0001");
    expect(coerceCellValue("DL01AB1234")).toBe("DL01AB1234");
    expect(coerceCellValue("")).toBe("");
  });
});
