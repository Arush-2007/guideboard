import { describe, expect, it } from "vitest";
import {
  describeCompareOptions,
  evaluateCondition,
  supportsCaseOption,
  supportsCharOption,
  supportsNumericOption,
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
      expect(evaluateCondition("contains", "a - b - c", "abc", opts)).toBe(
        true,
      );
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

  describe("numeric comparison of formatted values", () => {
    // The bug this covers: every numeric path parsed the RAW operand, so a
    // money cell answered false for any operator under any options.
    const chars = { ignoreChars: "₹," };

    it("orders currency-formatted amounts once the symbols are neglected", () => {
      expect(
        evaluateCondition("greater_than", "₹18,400.00", "₹13,500.00", chars),
      ).toBe(true);
      expect(
        evaluateCondition("less_than", "₹13,500.00", "₹18,400.00", chars),
      ).toBe(true);
      expect(
        evaluateCondition("greater_than", "₹13,500.00", "₹18,400.00", chars),
      ).toBe(false);
    });

    it("equates a formatted zero with a bare zero", () => {
      expect(
        evaluateCondition("equals", "₹0.00", "0", { numeric: true, ...chars }),
      ).toBe(true);
    });

    it("still refuses to order what is not a number after neglecting", () => {
      expect(evaluateCondition("greater_than", "N/A", "5", chars)).toBe(false);
      expect(evaluateCondition("greater_than", "", "5", chars)).toBe(false);
    });

    it("never lets ignoreChars change the VALUE of a number", () => {
      // Nothing clears the options when a condition's operator changes, so the
      // documented text example ("- ", for "RJ-09 AB") can land on the numeric
      // path. Stripping the sign there would invert the answer.
      const opts = { ignoreChars: "- " };
      expect(evaluateCondition("greater_than", "-5", "3", opts)).toBe(false);
      expect(evaluateCondition("less_than", "-5", "3", opts)).toBe(true);
      // A decimal point is equally load-bearing: "18.5" must not become 185.
      expect(
        evaluateCondition("greater_than", "18.5", "100", { ignoreChars: "." }),
      ).toBe(false);
      // The non-significant characters in the same list still get stripped.
      expect(evaluateCondition("greater_than", "- 18 400", "13500", opts)).toBe(
        false,
      );
    });

    it("does not case-fold on the numeric path", () => {
      // ignoreCase can only break a parseable token, never fix one, and the
      // run-detail summary already reports case as inert on ordering.
      expect(
        evaluateCondition("greater_than", "Infinity", "3", {
          ignoreCase: true,
        }),
      ).toBe(true);
    });

    it("is unchanged when no options are set", () => {
      // Without opting in, a formatted cell is still not a number — exact by
      // default is the existing contract, and this must not silently change.
      expect(
        evaluateCondition("greater_than", "₹18,400.00", "₹13,500.00", {}),
      ).toBe(false);
      expect(evaluateCondition("greater_than", "18400", "13500", {})).toBe(
        true,
      );
    });
  });

  describe("option gating + description helpers", () => {
    it("gates options to the operators where they apply", () => {
      expect(supportsCaseOption("equals")).toBe(true);
      expect(supportsCaseOption("contains")).toBe(true);
      // Case is meaningless once both sides are parsed as numbers.
      expect(supportsCaseOption("greater_than")).toBe(false);
      expect(supportsCaseOption("is_empty")).toBe(false);

      // Character-neglect DOES apply to ordering — it is what makes a
      // currency-formatted cell parse at all.
      expect(supportsCharOption("greater_than")).toBe(true);
      expect(supportsCharOption("less_than")).toBe(true);
      expect(supportsCharOption("equals")).toBe(true);
      expect(supportsCharOption("is_empty")).toBe(false);

      expect(supportsNumericOption("equals")).toBe(true);
      expect(supportsNumericOption("contains")).toBe(false);
      // Ordering is always numeric, so the toggle would be a no-op.
      expect(supportsNumericOption("greater_than")).toBe(false);
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
      // Ordering applies ONLY character-neglect: case can't matter once both
      // sides are parsed as numbers, and numeric is implicit there.
      expect(describeCompareOptions(all, "greater_than")).toBe('ignoring "- "');
      expect(describeCompareOptions(all, "less_than")).toBe('ignoring "- "');
      // Emptiness and row-selection operators apply none of them.
      expect(describeCompareOptions(all, "is_empty")).toBe("");
      expect(describeCompareOptions(all, "in_list")).toBe("");
    });
  });
});
