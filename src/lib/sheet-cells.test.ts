import { NonRetriableError } from "inngest";
import { describe, expect, it } from "vitest";
import { coerceCellValue, toCellNumber } from "./sheet-cells";

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

describe("toCellNumber", () => {
  it("parses numbers, treats empty as 0, and strips thousands commas", () => {
    expect(toCellNumber("1500", "Pending")).toBe(1500);
    expect(toCellNumber("", "Pending")).toBe(0);
    expect(toCellNumber(null, "Pending")).toBe(0);
    expect(toCellNumber(undefined, "Pending")).toBe(0);
    expect(toCellNumber("1,250.50", "Pending")).toBe(1250.5);
    expect(toCellNumber(4200, "Pending")).toBe(4200);
  });

  it("throws a NonRetriableError naming the column, with the given prefix", () => {
    expect(() =>
      toCellNumber("not a number", "Estimated", "Excel Action"),
    ).toThrow(NonRetriableError);
    try {
      toCellNumber("abc", "Estimated", "Google Sheets Action");
    } catch (e) {
      expect((e as Error).message).toContain("Google Sheets Action:");
      expect((e as Error).message).toContain('"Estimated"');
      expect((e as Error).message).toContain("non-numeric");
    }
  });
});
