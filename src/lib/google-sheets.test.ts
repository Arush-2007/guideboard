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
  cellFormatRequests,
  getSheetGrid,
  hexToRgb,
  mergedDataRows,
  readSheetTable,
  sheetRange,
  sheetsWrite,
  toSheetsError,
} from "./google-sheets";
import { CELL_FORMAT_FIELDS } from "./sheet-style";

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
    // insert can only address rows that exist. `merges` is empty when the tab
    // reports none; it is what identifies heading rows (see mergedDataRows).
    expect(grid).toEqual({ sheetId: 42, rowCount: 12, merges: [] });
  });

  it("omits merges by default, so the write paths stay cheap", async () => {
    kyGetMock.mockReturnValue(
      res({ sheets: [{ properties: { sheetId: 1, title: "T" } }] }),
    );
    await getSheetGrid({
      accessToken: "t",
      spreadsheetId: "s",
      sheetName: "T",
    });

    const [, options] = kyGetMock.mock.calls[0] as [
      string,
      { searchParams: { fields: string } },
    ];
    // Every append/whiten/color call goes through here for `sheetId` alone. A
    // workbook of report tabs can carry thousands of merge objects, so pulling
    // them on the write path would be pure cost.
    expect(options.searchParams.fields).not.toContain("merges");
    expect(options.searchParams.fields).toContain("sheetId");
  });

  it("asks for merges when the caller needs them", async () => {
    kyGetMock.mockReturnValue(
      res({ sheets: [{ properties: { sheetId: 1, title: "T" } }] }),
    );
    await getSheetGrid({
      accessToken: "t",
      spreadsheetId: "s",
      sheetName: "T",
      includeMerges: true,
    });

    const [, options] = kyGetMock.mock.calls[0] as [
      string,
      { searchParams: { fields: string } },
    ];
    // What actually matters is that `merges` is REQUESTED at all — it is the
    // sole input to heading detection, and a mask that omitted it would make
    // every heading silently undetectable. The exact grouping is style: the
    // `sheets.properties(...),sheets.merges` form returns the same payload
    // (verified live via scripts/dump-sheet-merges.ts).
    expect(options.searchParams.fields).toContain("merges");
    expect(options.searchParams.fields).toContain("sheetId");
    expect(options.searchParams.fields).toContain("rowCount");
  });

  it("returns the tab's merged ranges", async () => {
    kyGetMock.mockReturnValue(
      res({
        sheets: [
          {
            properties: {
              sheetId: 3,
              title: "Jobs",
              gridProperties: { rowCount: 50 },
            },
            // Note Google OMITS zero-valued fields, so a merge anchored at
            // column A carries no `startColumnIndex` at all.
            merges: [{ startRowIndex: 4, endRowIndex: 5, endColumnIndex: 3 }],
          },
        ],
      }),
    );
    const grid = await getSheetGrid({
      accessToken: "t",
      spreadsheetId: "s",
      sheetName: "Jobs",
      includeMerges: true,
    });

    expect(grid.merges).toEqual([
      { startRowIndex: 4, endRowIndex: 5, endColumnIndex: 3 },
    ]);
    // …and that omitted zero still reads as column A, so the row IS a heading.
    expect(mergedDataRows(grid.merges)).toEqual(new Map([[3, 3]]));
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
    expect(grid).toEqual({ sheetId: 7, rowCount: 0, merges: [] });
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

describe("mergedDataRows", () => {
  it("maps a single-row merge at column A to its DATA row index", () => {
    // Grid row 4 → data row 3 (grid row 0 is the header).
    expect(
      mergedDataRows([
        {
          startRowIndex: 4,
          endRowIndex: 5,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
      ]),
    ).toEqual(new Map([[3, 3]]));
  });

  // Pinning the index base, because the two consumers count from different
  // places and getting it wrong fails SILENTLY — the trigger would watch the row
  // under each section title instead of the title itself.
  //
  //   mergedDataRows  → DATA-row index, header EXCLUDED (readSheetTable.rows)
  //   the Sheets poll  → row index with the header AT 0 (the raw values array)
  //
  // So the poller adds one, and the heading's text is that row's column A.
  it("is one lower than the poller's row index for the same row", () => {
    //  grid 0 / poller 0 : Name | City   ← header
    //  grid 1 / poller 1 : ██ Q1 Sales ██ ← heading, data row 0
    //  grid 2 / poller 2 : Ada  | Pune
    const rows = [["Name", "City"], ["Q1 Sales"], ["Ada", "Pune"]];
    const merges = [
      {
        startRowIndex: 1,
        endRowIndex: 2,
        startColumnIndex: 0,
        endColumnIndex: 2,
      },
    ];

    const dataRows = [...mergedDataRows(merges).keys()];
    expect(dataRows).toEqual([0]);

    const pollerRows = dataRows.map((i) => i + 1);
    expect(pollerRows).toEqual([1]);
    // The conversion lands on the merged band, not the row beneath it.
    expect(rows[pollerRows[0]][0]).toBe("Q1 Sales");
  });

  it("ignores merges that are not merged-row-shaped", () => {
    expect(
      mergedDataRows([
        // Not anchored at column A — a mid-row merge in someone's data.
        {
          startRowIndex: 4,
          endRowIndex: 5,
          startColumnIndex: 1,
          endColumnIndex: 3,
        },
        // Taller than one row — a vertically merged label, not a merged row.
        {
          startRowIndex: 6,
          endRowIndex: 9,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
        // The HEADER row itself, merged. A merged header does not count.
        {
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 3,
        },
      ]),
    ).toEqual(new Map());
  });

  it("collects several merged rows, and is empty when the tab has no merges", () => {
    expect(
      mergedDataRows([
        {
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 2,
        },
        {
          startRowIndex: 7,
          endRowIndex: 8,
          startColumnIndex: 0,
          endColumnIndex: 2,
        },
      ]),
    ).toEqual(
      new Map([
        [0, 2],
        [6, 2],
      ]),
    );
    expect(mergedDataRows([])).toEqual(new Map());
  });
});

/**
 * The `fields` mask is the whole contract of "unset means leave it alone".
 *
 * These assertions are deliberately about the MASK, not just the payload: Sheets
 * writes exactly what the mask names, so a request carrying `{ bold: true }`
 * under a mask of `userEnteredFormat.textFormat` would still blank out italic,
 * size and colour. Every one of these cases has to be checked against the shape
 * that actually goes over the wire.
 */
describe("cellFormatRequests", () => {
  const range = { sheetId: 7, gridRow0: 4, startColumnIndex: 0 };
  const req = (over: Partial<Parameters<typeof cellFormatRequests>[0]>) =>
    cellFormatRequests({ ...range, endColumnIndex: 3, ...over }) as Array<
      Record<string, { fields?: string; range?: unknown; cell?: unknown }>
    >;

  it("names ONLY the properties that were set", () => {
    const [first] = req({ format: { backgroundColor: "#fef3c7" } });
    expect(first.repeatCell.fields).toBe("userEnteredFormat(backgroundColor)");
    expect(first.repeatCell.cell).toEqual({
      userEnteredFormat: { backgroundColor: hexToRgb("#fef3c7") },
    });
  });

  it("uses dotted sub-paths so a PARTIAL textFormat survives", () => {
    // The regression this guards: masking `textFormat` wholesale would wipe the
    // italic/size/colour a person set by hand on these cells.
    const [first] = req({ format: { bold: true } });
    expect(first.repeatCell.fields).toBe("userEnteredFormat(textFormat.bold)");
    expect(first.repeatCell.cell).toEqual({
      userEnteredFormat: { textFormat: { bold: true } },
    });
  });

  it("treats `false` as a real instruction, not as unset", () => {
    // "un-bold these cells" must reach Sheets; only `undefined` means leave be.
    const [first] = req({ format: { bold: false } });
    expect(first.repeatCell.fields).toBe("userEnteredFormat(textFormat.bold)");
    expect(first.repeatCell.cell).toEqual({
      userEnteredFormat: { textFormat: { bold: false } },
    });
  });

  // Every property in CELL_FORMAT_FIELDS must reach the mask — that table is the
  // single source the schema, the dialog and this builder all walk, so a
  // property added there and missed here would be accepted, offered, and never
  // sent. Compared as a SET: Sheets does not care about mask order, so asserting
  // the order would just break on a harmless reshuffle of the table.
  it("masks every property when a full format is given", () => {
    const [first] = req({
      format: {
        bold: true,
        italic: true,
        underline: true,
        strikethrough: true,
        fontSize: 14,
        textColor: "#000000",
        backgroundColor: "#ffffff",
        align: "CENTER",
        verticalAlign: "MIDDLE",
      },
    });
    const masked = (first.repeatCell.fields ?? "")
      .replace(/^userEnteredFormat\(|\)$/g, "")
      .split(",")
      .sort();
    expect(masked).toEqual(
      [
        "backgroundColor",
        "horizontalAlignment",
        "verticalAlignment",
        "textFormat.bold",
        "textFormat.italic",
        "textFormat.underline",
        "textFormat.strikethrough",
        "textFormat.fontSize",
        "textFormat.foregroundColor",
      ].sort(),
    );
    // One entry per declared style property, so nothing is silently dropped.
    expect(masked).toHaveLength(CELL_FORMAT_FIELDS.length);
  });

  it("emits nothing at all when the format sets nothing and merge is off", () => {
    expect(req({})).toEqual([]);
    expect(req({ format: {}, merge: "none" })).toEqual([]);
  });

  it("emits the merge alone when only merging was asked for", () => {
    const requests = req({ merge: "merge" });
    expect(requests).toHaveLength(1);
    expect(requests[0].mergeCells).toEqual({
      range: {
        sheetId: 7,
        startRowIndex: 4,
        endRowIndex: 5,
        startColumnIndex: 0,
        endColumnIndex: 3,
      },
      mergeType: "MERGE_ALL",
    });
  });

  it("styles BEFORE merging — a merge inherits the top-left cell's format", () => {
    const requests = req({ format: { bold: true }, merge: "merge" });
    expect(Object.keys(requests[0])).toEqual(["repeatCell"]);
    expect(Object.keys(requests[1])).toEqual(["mergeCells"]);
  });

  it("skips the merge for a band under 2 columns wide", () => {
    // Sheets rejects a single-cell merge, and there is nothing to span.
    expect(req({ endColumnIndex: 1, merge: "merge" })).toEqual([]);
  });

  it("unmerges a band that is actually merged", () => {
    const requests = req({ merge: "unmerge" });
    expect(requests).toHaveLength(1);
    expect(requests[0].unmergeCells).toEqual({
      range: {
        sheetId: 7,
        startRowIndex: 4,
        endRowIndex: 5,
        startColumnIndex: 0,
        endColumnIndex: 3,
      },
    });
  });

  // Callers pass the row's REAL merged width, so a one-cell span means "this row
  // isn't merged" — not "unmerge this single cell".
  it("skips the unmerge for a one-cell span", () => {
    expect(req({ endColumnIndex: 1, merge: "unmerge" })).toEqual([]);
  });

  // Sheets rejects a merge/unmerge range that partially intersects an existing
  // merge, so the merge band must be able to differ from the format band.
  it("honours mergeSpan independently of the format band", () => {
    const requests = req({
      endColumnIndex: 4,
      format: { bold: true },
      merge: "merge",
      mergeSpan: { startColumnIndex: 0, endColumnIndex: 2 },
    });
    // Format across the full band…
    expect(
      (requests[0].repeatCell as unknown as { range: Record<string, number> })
        .range.endColumnIndex,
    ).toBe(4);
    // …merge only across the row's real width.
    expect(
      (requests[1].mergeCells as unknown as { range: Record<string, number> })
        .range.endColumnIndex,
    ).toBe(2);
  });

  it("skips the merge when mergeSpan is under 2 columns", () => {
    expect(
      req({
        merge: "merge",
        mergeSpan: { startColumnIndex: 0, endColumnIndex: 1 },
      }),
    ).toEqual([]);
  });

  it("honours a column subset rather than always starting at A", () => {
    const [first] = cellFormatRequests({
      sheetId: 7,
      gridRow0: 4,
      startColumnIndex: 2,
      endColumnIndex: 5,
      format: { bold: true },
    }) as Array<Record<string, { range?: unknown }>>;
    expect(first.repeatCell.range).toEqual({
      sheetId: 7,
      startRowIndex: 4,
      endRowIndex: 5,
      startColumnIndex: 2,
      endColumnIndex: 5,
    });
  });

  it("throws on a malformed colour before anything is written", () => {
    expect(() => req({ format: { backgroundColor: "nope" } })).toThrow(
      NonRetriableError,
    );
  });
});
