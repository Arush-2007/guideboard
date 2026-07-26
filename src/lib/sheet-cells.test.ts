import { NonRetriableError } from "inngest";
import { describe, expect, it } from "vitest";
import {
  coerceCellValue,
  isPaddedNumberId,
  stripTextForcing,
  toCellNumber,
  toSheetsCellText,
  toSheetsCellValue,
} from "./sheet-cells";

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

describe("isPaddedNumberId", () => {
  it("recognises only numerics whose leading zero carries meaning", () => {
    expect(isPaddedNumberId("0001")).toBe(true);
    expect(isPaddedNumberId("007")).toBe(true);
    expect(isPaddedNumberId(" 0009 ")).toBe(true);
    // A bare zero, an ordinary number, and a decimal are not padded ids.
    expect(isPaddedNumberId("0")).toBe(false);
    expect(isPaddedNumberId("42")).toBe(false);
    expect(isPaddedNumberId("0.5")).toBe(false);
    // Non-numeric text never needs forcing — Sheets keeps it as-is.
    expect(isPaddedNumberId("RJ34UA4176")).toBe(false);
    expect(isPaddedNumberId("")).toBe(false);
  });
});

// Verified against the live Sheets API: USER_ENTERED parses every value "as if
// typed", so "0009" is stored as the NUMBER 9 while "'0009" stores the TEXT
// "0009" (the apostrophe is consumed on write).
describe("toSheetsCellText / toSheetsCellValue", () => {
  it("force-texts a padded id so USER_ENTERED can't eat the zeros", () => {
    expect(toSheetsCellText("0009")).toBe("'0009");
    expect(toSheetsCellValue("0009")).toBe("'0009");
  });

  it("leaves everything else alone", () => {
    expect(toSheetsCellText("RJ34UA4176")).toBe("RJ34UA4176");
    expect(toSheetsCellText("")).toBe("");
  });

  it("keeps clean numerics as real numbers where the payload allows it", () => {
    // The row builder needs string[]; an update's ValueRange can carry numbers.
    expect(toSheetsCellText("125")).toBe("125");
    expect(toSheetsCellValue("125")).toBe(125);
    expect(toSheetsCellValue("-3.5")).toBe(-3.5);
  });
});

describe("stripTextForcing", () => {
  it("removes the write artifact so workflows see the clean value", () => {
    expect(stripTextForcing("'0009")).toBe("0009");
    expect(stripTextForcing("0009")).toBe("0009");
  });

  it("preserves an apostrophe a user actually meant", () => {
    expect(stripTextForcing("'hello")).toBe("'hello");
    // Not a padded id, so we never forced it — leave it be.
    expect(stripTextForcing("'42")).toBe("'42");
  });

  it("round-trips with the encoder for already-trimmed values", () => {
    for (const v of ["0009", "125", "RJ34UA4176", ""]) {
      expect(stripTextForcing(toSheetsCellText(v))).toBe(v);
    }
  });

  it("is NOT an identity for a padded id with surrounding whitespace", () => {
    // Deliberate: the encoder normalizes ids (whitespace around one is never
    // meaningful) while leaving free text alone. Asserted so the asymmetry is a
    // documented decision rather than something a later change breaks silently.
    expect(stripTextForcing(toSheetsCellText(" 0009 "))).toBe("0009");
    expect(stripTextForcing(toSheetsCellText(" abc "))).toBe(" abc ");
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
