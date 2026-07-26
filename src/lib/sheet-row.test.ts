import { describe, expect, it } from "vitest";
import { encodeCustomFeatureToken } from "./custom-feature-token";
import { sanitizeHeaderKey } from "./sheet-headers";
import {
  buildRowByHeader,
  buildSheetRow,
  findBlankRequired,
  isSerialHeader,
} from "./sheet-row";

const context = {
  telegram: {
    from: { firstName: "Ada" },
    contact: { phoneNumber: "+15551234567" },
  },
  ai_text_a1: { output: "intern" },
};

const serial = (params?: { start?: number; pad?: number }) =>
  encodeCustomFeatureToken("serialNumber", params ?? {});

describe("isSerialHeader (legacy, Excel-only)", () => {
  it("matches common serial-column names", () => {
    for (const h of [
      "S.No",
      "Sr No",
      "Serial",
      "Serial No",
      "Serial Number",
      "Sno",
      "#",
    ]) {
      expect(isSerialHeader(h)).toBe(true);
    }
  });
  it("does not match normal columns (incl. Job No — now token-driven)", () => {
    for (const h of ["Name", "Phone", "Notes", "Number of seats", "Job No"]) {
      expect(isSerialHeader(h)).toBe(false);
    }
  });
});

describe("buildSheetRow", () => {
  const headers = ["Job No", "Name", "Mobile No", "Category", "Untouched"];
  const mappings = {
    "Job No": serial({ start: 1, pad: 4 }),
    Name: "@<telegram.from.firstName>@",
    "Mobile No": "@<telegram.contact.phoneNumber>@",
    Category: "@<ai_text_a1.output>@",
  };

  it("autofills the Serial Number column (max+1, padded), resolves mappings, blanks the rest", () => {
    const row = buildSheetRow({
      headers,
      mappings,
      context,
      rows: [
        ["0001", "X", "", "", ""],
        ["0003", "Y", "", "", ""],
      ],
    });
    expect(row).toEqual(["0004", "Ada", "+15551234567", "intern", ""]);
  });

  it("starts an empty serial column at the token's start value", () => {
    const row = buildSheetRow({
      headers: ["Job No"],
      mappings: { "Job No": serial({ start: 100, pad: 4 }) },
      context,
    });
    expect(row).toEqual(["0100"]);
  });

  it("floors max+1 at the start value", () => {
    const row = buildSheetRow({
      headers: ["Job No"],
      mappings: { "Job No": serial({ start: 1000 }) },
      context,
      rows: [["5"], ["9"]],
    });
    expect(row).toEqual(["1000"]);
  });

  it("ignores non-numeric cells when computing the next serial", () => {
    const row = buildSheetRow({
      headers: ["Job No"],
      mappings: { "Job No": serial({ start: 1 }) },
      context,
      rows: [["abc"], ["0007"], ["n/a"]],
    });
    expect(row).toEqual(["8"]);
  });

  it("does not auto-fill by header name (heuristic removed for Sheets)", () => {
    const row = buildSheetRow({
      headers: ["S.No", "Name"],
      mappings: { Name: "@<telegram.from.firstName>@" },
      context,
      rows: [["1", "X"]],
    });
    expect(row).toEqual(["", "Ada"]);
  });

  it("passes a mapped formula string through untouched", () => {
    const row = buildSheetRow({
      headers: ["Total"],
      mappings: { Total: "=SUM(A2:A10)" },
      context,
    });
    expect(row).toEqual(["=SUM(A2:A10)"]);
  });

  it("tolerates header whitespace when matching mappings", () => {
    const row = buildSheetRow({
      headers: ["  Name  "],
      mappings: { Name: "@<telegram.from.firstName>@" },
      context,
    });
    expect(row).toEqual(["Ada"]);
  });

  it("prefixes a padded serial with a text-forcing apostrophe when forceTextIds is set", () => {
    const row = buildSheetRow({
      headers: ["Job No"],
      mappings: { "Job No": serial({ start: 1, pad: 4 }) },
      context,
      rows: [["0005"]],
      forceTextIds: true,
    });
    expect(row).toEqual(["'0006"]);
  });

  it("does not add the apostrophe when padding is 0, even with forceTextIds", () => {
    const row = buildSheetRow({
      headers: ["Job No"],
      mappings: { "Job No": serial({ start: 7 }) },
      context,
      forceTextIds: true,
    });
    expect(row).toEqual(["7"]);
  });

  // The regression this rule exists for: a job number generated in one sheet and
  // REFERENCED into another is not a serial token there, so the old serial-only
  // rule left it bare and USER_ENTERED rewrote "0009" as the number 9.
  it("force-texts a padded id that was referenced in, not generated", () => {
    const row = buildSheetRow({
      headers: ["Job No", "Name", "Km"],
      mappings: {
        "Job No": "@<sheetA.rowByHeader.Job No>@",
        Name: "@<sheetA.rowByHeader.Name>@",
        Km: "@<sheetA.rowByHeader.Km>@",
      },
      context: {
        sheetA: {
          rowByHeader: { "Job No": "0009", Name: "Ada", Km: "190000" },
        },
      },
      forceTextIds: true,
    });
    // Only the padded id is forced; ordinary numbers stay numeric-looking so
    // Sheets still stores them as numbers.
    expect(row).toEqual(["'0009", "Ada", "190000"]);
  });

  it("leaves padded ids bare for the Excel path (no forceTextIds)", () => {
    const row = buildSheetRow({
      headers: ["Job No"],
      mappings: { "Job No": "@<a.jobNo>@" },
      context: { a: { jobNo: "0009" } },
    });
    // An apostrophe would land in the cell literally on a raw Graph write.
    expect(row).toEqual(["0009"]);
  });

  it("legacy header-name serial still autofills for the Excel path", () => {
    const row = buildSheetRow({
      headers: ["S.No", "Name"],
      mappings: { Name: "@<telegram.from.firstName>@" },
      context,
      legacyHeaderSerial: true,
      legacyRowCount: 4,
    });
    expect(row).toEqual(["5", "Ada"]);
  });
});

describe("sanitizeHeaderKey", () => {
  it("strips dots so getByPath does not split the key", () => {
    expect(sanitizeHeaderKey("Job No.")).toBe("Job No");
    expect(sanitizeHeaderKey("A.B.C")).toBe("ABC");
  });
  it("trims surrounding whitespace", () => {
    expect(sanitizeHeaderKey("  Pending  ")).toBe("Pending");
  });
});

describe("findBlankRequired", () => {
  const headers = ["Job No", "Name", "Mobile No"];

  it("flags required columns whose cell is blank or whitespace", () => {
    expect(
      findBlankRequired(headers, ["0001", "", "  "], ["Name", "Mobile No"]),
    ).toEqual(["Name", "Mobile No"]);
  });

  it("passes when required columns are filled", () => {
    expect(findBlankRequired(headers, ["0001", "Ada", "+1"], ["Name"])).toEqual(
      [],
    );
  });

  it("ignores optional blanks (empty or undefined required list)", () => {
    expect(findBlankRequired(headers, ["0001", "", ""], [])).toEqual([]);
    expect(findBlankRequired(headers, ["0001", "", ""], undefined)).toEqual([]);
  });

  it("matches header names trim-tolerantly", () => {
    expect(findBlankRequired(["  Name  "], [""], ["Name"])).toEqual(["Name"]);
  });

  it("never flags a Serial Number cell (it is always populated)", () => {
    const row = buildSheetRow({
      headers,
      mappings: { "Job No": serial({ start: 1, pad: 4 }) },
      context,
    });
    expect(findBlankRequired(headers, row, ["Job No"])).toEqual([]);
  });
});

describe("buildRowByHeader", () => {
  it("keys by header and strips the force-text apostrophe", () => {
    expect(buildRowByHeader(["Job No", "Name"], ["'0006", "Ada"])).toEqual({
      "Job No": "0006",
      Name: "Ada",
    });
  });

  // Mapping-agnostic: a padded id referenced in from another sheet is
  // force-written too, and the old serial-only check would have let `'0009`
  // leak downstream.
  it("strips it regardless of how the column was mapped", () => {
    expect(buildRowByHeader(["Job No"], ["'0009"])).toEqual({
      "Job No": "0009",
    });
  });

  it("strips dots from header keys", () => {
    expect(buildRowByHeader(["Job No."], ["0001"])).toEqual({
      "Job No": "0001",
    });
  });

  it("preserves a literal apostrophe that isn't a force-text marker", () => {
    expect(buildRowByHeader(["Note"], ["'hello"])).toEqual({ Note: "'hello" });
    // …including one in front of a NON-padded number, which we never force.
    expect(buildRowByHeader(["Note"], ["'42"])).toEqual({ Note: "'42" });
  });
});
