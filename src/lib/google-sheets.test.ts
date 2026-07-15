import { NonRetriableError, RetryAfterError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake ky with a routed GET mock; FakeHTTPError mirrors ky's HTTPError shape so
// the error mapping (instanceof + response.status/headers/json) is under test.
const { kyGetMock, kyPostMock, FakeHTTPError, FakeTimeoutError } = vi.hoisted(
  () => {
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
    // Mirrors ky's TimeoutError so `isTimeout` (an `instanceof TimeoutError`
    // check in http.ts, importing the same mocked class) recognises it.
    class FakeTimeoutError extends Error {}
    return {
      kyGetMock: vi.fn(),
      kyPostMock: vi.fn(),
      FakeHTTPError,
      FakeTimeoutError,
    };
  },
);
// HTTP now goes through the shared client in `http.ts` (`ky.create(...)`), so the
// mock must answer `create` — returning the same fake instance, so the assertions
// below still see the calls.
vi.mock("ky", () => {
  const instance = { get: kyGetMock, post: kyPostMock };
  return {
    default: { ...instance, create: () => instance },
    HTTPError: FakeHTTPError,
    TimeoutError: FakeTimeoutError,
  };
});

import {
  getSheetGrid,
  hexToRgb,
  readSheetTable,
  sheetRange,
  sheetsWrite,
  toSheetsError,
} from "./google-sheets";

const res = (value: unknown) =>
  Object.assign(Promise.resolve(value), { json: () => Promise.resolve(value) });

beforeEach(() => {
  kyGetMock.mockReset();
  kyPostMock.mockReset();
});

describe("sheetRange", () => {
  it("quotes the tab name so names with spaces parse (the whole point)", () => {
    // Unquoted, Sheets rejects this with 400 "Unable to parse range".
    expect(sheetRange("Job Cards", "A:ZZ")).toBe("'Job Cards'!A:ZZ");
  });

  it("quotes unconditionally — a plain name is valid quoted too", () => {
    expect(sheetRange("Ledger", "A2:ZZ2")).toBe("'Ledger'!A2:ZZ2");
  });

  it("escapes an apostrophe in the tab name by doubling it", () => {
    expect(sheetRange("Bob's Jobs", "1:1")).toBe("'Bob''s Jobs'!1:1");
  });

  it("trims surrounding whitespace off the tab name", () => {
    expect(sheetRange("  Ledger  ", "A:ZZ")).toBe("'Ledger'!A:ZZ");
  });
});

describe("readSheetTable", () => {
  it("requests a QUOTED range, so a tab name with a space is readable", async () => {
    kyGetMock.mockReturnValue(res({ values: [["A"]] }));

    await readSheetTable({
      accessToken: "t",
      spreadsheetId: "s",
      sheetName: "Job Cards",
    });

    const [url] = kyGetMock.mock.calls[0] as [string];
    expect(decodeURIComponent(url)).toContain("'Job Cards'!A:ZZ");
  });

  it("trims headers, aligns rows to header width, and keys rowsByHeader", async () => {
    kyGetMock.mockReturnValue(
      res({
        values: [
          [" Service Buyer ", "Pending", "Buyer Type"],
          ["Govt PWD", "1500", "Government", "extra-ignored"],
          ["Private Co"], // short row, padded to header width
        ],
      }),
    );

    const table = await readSheetTable({
      accessToken: "t",
      spreadsheetId: "s",
      sheetName: "Ledger",
    });

    expect(table.headers).toEqual(["Service Buyer", "Pending", "Buyer Type"]);
    expect(table.rows).toEqual([
      ["Govt PWD", "1500", "Government"],
      ["Private Co", "", ""],
    ]);
    expect(table.rowsByHeader[0]).toEqual({
      "Service Buyer": "Govt PWD",
      Pending: "1500",
      "Buyer Type": "Government",
    });
    expect(table.rowsByHeader[1]).toEqual({
      "Service Buyer": "Private Co",
      Pending: "",
      "Buyer Type": "",
    });
  });

  it("returns empty structures for an empty sheet", async () => {
    kyGetMock.mockReturnValue(res({}));
    const table = await readSheetTable({
      accessToken: "t",
      spreadsheetId: "s",
      sheetName: "Ledger",
    });
    expect(table).toEqual({ headers: [], rows: [], rowsByHeader: [] });
  });

  it("keys blank headers as colN", async () => {
    kyGetMock.mockReturnValue(
      res({
        values: [
          ["A", ""],
          ["1", "2"],
        ],
      }),
    );
    const table = await readSheetTable({
      accessToken: "t",
      spreadsheetId: "s",
      sheetName: "Sheet1",
    });
    expect(table.rowsByHeader[0]).toEqual({ A: "1", col2: "2" });
  });
});

describe("getSheetGrid", () => {
  it("resolves the sheetId + grid height with a case-insensitive title match", async () => {
    kyGetMock.mockReturnValue(
      res({
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: "Master",
              gridProperties: { rowCount: 1000 },
            },
          },
          {
            properties: {
              sheetId: 42,
              title: "Grouped",
              gridProperties: { rowCount: 12 },
            },
          },
        ],
      }),
    );
    const grid = await getSheetGrid({
      accessToken: "t",
      spreadsheetId: "s",
      sheetName: "grouped",
    });
    // rowCount is how many rows the GRID has, not how many hold data — an
    // insert can only address rows that exist.
    expect(grid).toEqual({ sheetId: 42, rowCount: 12 });
  });

  it("reports rowCount 0 when the tab has no gridProperties", async () => {
    kyGetMock.mockReturnValue(
      res({ sheets: [{ properties: { sheetId: 7, title: "Grouped" } }] }),
    );
    const grid = await getSheetGrid({
      accessToken: "t",
      spreadsheetId: "s",
      sheetName: "Grouped",
    });
    expect(grid).toEqual({ sheetId: 7, rowCount: 0 });
  });

  it("throws NonRetriableError when the tab is absent", async () => {
    kyGetMock.mockReturnValue(
      res({ sheets: [{ properties: { sheetId: 0, title: "Master" } }] }),
    );
    await expect(
      getSheetGrid({
        accessToken: "t",
        spreadsheetId: "s",
        sheetName: "Ledger",
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });
});

describe("toSheetsError", () => {
  it("maps 429 to RetryAfterError honoring Retry-After", async () => {
    const err = await toSheetsError(
      new FakeHTTPError(
        429,
        { error: { message: "rate limited" } },
        {
          "retry-after": "17",
        },
      ),
    );
    expect(err).toBeInstanceOf(RetryAfterError);
    expect(String((err as RetryAfterError).retryAfter)).toContain("17");
  });

  it("maps 404/403/401/400 to NonRetriableError", async () => {
    for (const status of [400, 401, 403, 404]) {
      const err = await toSheetsError(
        new FakeHTTPError(status, { error: { status: "NOT_FOUND" } }),
      );
      expect(err).toBeInstanceOf(NonRetriableError);
    }
  });

  it("leaves 5xx retriable (plain Error)", async () => {
    const err = await toSheetsError(new FakeHTTPError(500));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetriableError);
    expect(err).not.toBeInstanceOf(RetryAfterError);
  });

  it("passes a non-HTTP error through unchanged", async () => {
    const original = new Error("boom");
    expect(await toSheetsError(original)).toBe(original);
  });
});

describe("sheetsWrite timeout classification", () => {
  // The regression this pins: absolute-range writes (values:batchUpdate, final
  // values to fixed A1 ranges) are retry-safe, but :append / insertDimension are
  // not. Both share one timeout clock via sheetsWrite; only the retry decision
  // differs, keyed by the `idempotent` option.
  beforeEach(() => {
    kyPostMock.mockRejectedValue(new FakeTimeoutError("Request timed out"));
  });

  it("classifies a default write timeout (append/insert) as NON-retriable", async () => {
    await expect(
      sheetsWrite("https://sheets.example/values/A:ZZ:append", {
        headers: {},
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
  });

  it("classifies an absolute-range write timeout as RETRIABLE", async () => {
    await expect(
      sheetsWrite(
        "https://sheets.example/values:batchUpdate",
        { headers: {} },
        { idempotent: true },
      ),
    ).rejects.toBeInstanceOf(RetryAfterError);
  });
});

describe("hexToRgb", () => {
  it("converts #RRGGBB to 0..1 channels, with or without # and any case", () => {
    expect(hexToRgb("#ff0000")).toEqual({ red: 1, green: 0, blue: 0 });
    expect(hexToRgb("00FF00")).toEqual({ red: 0, green: 1, blue: 0 });
    expect(hexToRgb("#0000FF")).toEqual({ red: 0, green: 0, blue: 1 });
  });

  it("throws NonRetriableError on a malformed hex", () => {
    expect(() => hexToRgb("#fff")).toThrow(NonRetriableError);
    expect(() => hexToRgb("red")).toThrow(NonRetriableError);
    expect(() => hexToRgb("#12345g")).toThrow(NonRetriableError);
  });
});
