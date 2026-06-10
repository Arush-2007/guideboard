import { describe, expect, it } from "vitest";
import { buildSheetRow, isSerialHeader } from "./sheet-row";

const context = {
  telegram: {
    from: { firstName: "Ada" },
    contact: { phoneNumber: "+15551234567" },
  },
  ai_text_a1: { output: "intern" },
};

describe("isSerialHeader", () => {
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
  it("does not match normal columns", () => {
    for (const h of ["Name", "Phone", "Email", "Notes", "Number of seats"]) {
      expect(isSerialHeader(h)).toBe(false);
    }
  });
});

describe("buildSheetRow", () => {
  const headers = ["S.No", "Name", "Mobile No", "Category", "Untouched"];
  const mappings = {
    Name: "!#telegram.from.firstName#!",
    "Mobile No": "!#telegram.contact.phoneNumber#!",
    Category: "!#ai_text_a1.output#!",
  };

  it("orders cells by header, resolves mappings, auto-fills serial, blanks the rest", () => {
    const row = buildSheetRow({
      headers,
      mappings,
      context,
      currentDataRowCount: 4, // 4 existing data rows -> next serial = 5
    });
    expect(row).toEqual(["5", "Ada", "+15551234567", "intern", ""]);
  });

  it("respects an explicitly mapped serial column over auto-fill", () => {
    const row = buildSheetRow({
      headers: ["S.No", "Name"],
      mappings: { "S.No": "100", Name: "!#telegram.from.firstName#!" },
      context,
      currentDataRowCount: 4,
    });
    expect(row).toEqual(["100", "Ada"]);
  });

  it("tolerates header whitespace when matching mappings", () => {
    const row = buildSheetRow({
      headers: ["  Name  "],
      mappings: { Name: "!#telegram.from.firstName#!" },
      context,
      currentDataRowCount: 0,
    });
    expect(row).toEqual(["Ada"]);
  });
});
