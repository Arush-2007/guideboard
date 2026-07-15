import { describe, expect, it } from "vitest";
import { COMPARE_OPERATOR_LABELS } from "@/features/executions/lib/compare";
import {
  ROW_MATCH_OPERATOR_LABELS,
  ROW_MATCH_OPERATORS,
  VALUELESS_ROW_MATCH_OPERATORS,
} from "./row-match-operators";

describe("row-match operators (single source)", () => {
  it("labels every operator; the list is derived from the labels", () => {
    expect(ROW_MATCH_OPERATORS).toHaveLength(11);
    for (const op of ROW_MATCH_OPERATORS) {
      expect(ROW_MATCH_OPERATOR_LABELS[op]).toBeTruthy();
    }
  });

  it("reuses the 8 base operators from compare.ts plus the 3 selection ops", () => {
    for (const op of Object.keys(COMPARE_OPERATOR_LABELS)) {
      expect(ROW_MATCH_OPERATORS).toContain(op);
    }
    expect(ROW_MATCH_OPERATORS).toContain("older_than_days");
    expect(ROW_MATCH_OPERATORS).toContain("within_days");
    expect(ROW_MATCH_OPERATORS).toContain("in_list");
  });

  it("marks only the valueless operators", () => {
    expect(VALUELESS_ROW_MATCH_OPERATORS.has("is_empty")).toBe(true);
    expect(VALUELESS_ROW_MATCH_OPERATORS.has("is_not_empty")).toBe(true);
    expect(VALUELESS_ROW_MATCH_OPERATORS.has("equals")).toBe(false);
    expect(VALUELESS_ROW_MATCH_OPERATORS.has("in_list")).toBe(false);
  });
});
