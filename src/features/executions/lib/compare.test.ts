import { describe, expect, it } from "vitest";
import { evaluateCondition } from "./compare";

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
});
