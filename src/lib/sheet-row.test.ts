import { describe, expect, it } from "vitest";
import { encodeCustomFeatureToken } from "./custom-feature-token";
import { buildSheetRow, isSerialHeader } from "./sheet-row";

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

  it("prefixes a padded serial with a text-forcing apostrophe when serialAsText is set", () => {
    const row = buildSheetRow({
      headers: ["Job No"],
      mappings: { "Job No": serial({ start: 1, pad: 4 }) },
      context,
      rows: [["0005"]],
      serialAsText: true,
    });
    expect(row).toEqual(["'0006"]);
  });

  it("does not add the apostrophe when padding is 0, even with serialAsText", () => {
    const row = buildSheetRow({
      headers: ["Job No"],
      mappings: { "Job No": serial({ start: 7 }) },
      context,
      serialAsText: true,
    });
    expect(row).toEqual(["7"]);
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
