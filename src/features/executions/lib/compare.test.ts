import { describe, expect, it } from "vitest";
import {
  describeCompareOptions,
  evaluateCondition,
  supportsNumericOption,
  supportsTextOptions,
} from "./compare";

describe("evaluateCondition", () => {
  describe("numeric operators", () => {
    it("compares real numbers numerically, not lexicographically", () => {
      expect(evaluateCondition("greater_than", "10", "9")).toBe(true);
      expect(evaluateCondition("less_than", "9", "10")).toBe(true);
      expect(evaluateCondition("greater_than", 3, "5")).toBe(false);
    });

    it("trims numeric strings before coercing", () => {
      expect(evaluateCondition("greater_than", " 7 ", " 5 ")).toBe(true);
    });

    it("never treats an empty field value as 0", () => {
      // A missing reference renders to "" — it must not satisfy any ordering.
      expect(evaluateCondition("less_than", "", "2")).toBe(false);
      expect(evaluateCondition("greater_than", "", "-1")).toBe(false);
    });

    it("never treats an empty compare value as 0", () => {
      expect(evaluateCondition("greater_than", "5", "")).toBe(false);
      expect(evaluateCondition("less_than", "-5", "")).toBe(false);
    });

    it("returns false when either side is not a number", () => {
      expect(evaluateCondition("greater_than", "abc", "1")).toBe(false);
      expect(evaluateCondition("less_than", "1", "abc")).toBe(false);
      expect(evaluateCondition("greater_than", undefined, "1")).toBe(false);
    });
  });

  describe("contains / not_contains", () => {
    it("matches substrings", () => {
      expect(evaluateCondition("contains", "hello world", "world")).toBe(true);
      expect(evaluateCondition("not_contains", "hello", "world")).toBe(true);
    });

    it("treats an empty needle as no-match (not a tautology)", () => {
      expect(evaluateCondition("contains", "hello", "")).toBe(false);
      // not_contains stays the exact negation of contains.
      expect(evaluateCondition("not_contains", "hello", "")).toBe(true);
    });
  });

  describe("equals / emptiness (unchanged semantics)", () => {
    it("equals compares stringified values, including empty", () => {
      expect(evaluateCondition("equals", "", "")).toBe(true);
      expect(evaluateCondition("not_equals", "a", "b")).toBe(true);
    });

    it("is_empty / is_not_empty check the field value only", () => {
      expect(evaluateCondition("is_empty", "  ", "")).toBe(true);
      expect(evaluateCondition("is_empty", [], "")).toBe(true);
      expect(evaluateCondition("is_not_empty", "x", "")).toBe(true);
      expect(evaluateCondition("is_empty", 0, "")).toBe(false);
    });
  });

  describe("matching options", () => {
    it("no options preserves exact, case-sensitive behavior", () => {
      expect(evaluateCondition("equals", "RJ", "rj")).toBe(false);
      expect(evaluateCondition("equals", "0001", "1")).toBe(false);
      expect(evaluateCondition("equals", "RJ-09 AB", "RJ09AB")).toBe(false);
    });

    it("ignoreCase folds case for equals and contains", () => {
      const opts = { ignoreCase: true };
      expect(evaluateCondition("equals", "RJ", "rj", opts)).toBe(true);
      expect(evaluateCondition("not_equals", "RJ", "rj", opts)).toBe(false);
      expect(evaluateCondition("contains", "Hello World", "world", opts)).toBe(
        true,
      );
    });

    it("ignoreChars strips the listed characters (a space included)", () => {
      // Neglect hyphen and space, fold case → the messy vehicle number matches.
      const opts = { ignoreChars: "- ", ignoreCase: true };
      expect(
        evaluateCondition("equals", "RJ-09 AB 1234", "rj09ab1234", opts),
      ).toBe(true);
      expect(evaluateCondition("contains", "a - b - c", "abc", opts)).toBe(true);
    });

    it("a needle that strips to empty is a no-match, not a tautology", () => {
      const opts = { ignoreChars: "-" };
      expect(evaluateCondition("contains", "a-b", "-", opts)).toBe(false);
      expect(evaluateCondition("not_contains", "a-b", "-", opts)).toBe(true);
    });

    it("numeric equates leading zeros / decimals when both parse", () => {
      const opts = { numeric: true };
      expect(evaluateCondition("equals", "0001", "1", opts)).toBe(true);
      expect(evaluateCondition("equals", "1.0", "1", opts)).toBe(true);
      expect(evaluateCondition("not_equals", "0001", "2", opts)).toBe(true);
    });

    it("numeric stays EXACT for long integers (no float rounding)", () => {
      const opts = { numeric: true };
      // These differ only past 2^53 — Number() would collapse them to equal.
      expect(
        evaluateCondition(
          "equals",
          "12345678901234567",
          "12345678901234568",
          opts,
        ),
      ).toBe(false);
      // Leading zeros on a long integer still normalize to equal.
      expect(
        evaluateCondition(
          "equals",
          "0012345678901234567",
          "12345678901234567",
          opts,
        ),
      ).toBe(true);
    });

    it("numeric falls back to (normalized) string compare when not both numeric", () => {
      const opts = { numeric: true, ignoreCase: true };
      expect(evaluateCondition("equals", "RJ", "rj", opts)).toBe(true);
      expect(evaluateCondition("equals", "abc", "1", opts)).toBe(false);
    });
  });

  describe("option gating + description helpers", () => {
    it("gates options to the operators where they apply", () => {
      expect(supportsTextOptions("equals")).toBe(true);
      expect(supportsTextOptions("contains")).toBe(true);
      expect(supportsTextOptions("greater_than")).toBe(false);
      expect(supportsTextOptions("is_empty")).toBe(false);
      expect(supportsNumericOption("equals")).toBe(true);
      expect(supportsNumericOption("contains")).toBe(false);
    });

    it("describes only the active options, empty when none", () => {
      expect(describeCompareOptions(undefined)).toBe("");
      expect(describeCompareOptions({})).toBe("");
      expect(
        describeCompareOptions({
          ignoreCase: true,
          ignoreChars: "- ",
          numeric: true,
        }),
      ).toBe('case-insensitive · ignoring "- " · as number');
    });

    it("gates the description by operator so inert options aren't shown", () => {
      const all = { ignoreCase: true, ignoreChars: "- ", numeric: true };
      // equals uses all three.
      expect(describeCompareOptions(all, "equals")).toBe(
        'case-insensitive · ignoring "- " · as number',
      );
      // contains ignores numeric.
      expect(describeCompareOptions(all, "contains")).toBe(
        'case-insensitive · ignoring "- "',
      );
      // ordering / emptiness / row-selection operators apply none of them.
      expect(describeCompareOptions(all, "greater_than")).toBe("");
      expect(describeCompareOptions(all, "is_empty")).toBe("");
      expect(describeCompareOptions(all, "in_list")).toBe("");
    });
  });
});
