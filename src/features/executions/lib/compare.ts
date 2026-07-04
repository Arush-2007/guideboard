/**
 * Shared value comparison for branching nodes (Condition, Switch). Both nodes
 * evaluate the same operator set against a (templated) field value and a
 * (templated) comparison value, so the comparator lives here once rather than
 * being duplicated per node.
 */
export type CompareOperator =
  | "contains"
  | "not_contains"
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "is_empty"
  | "is_not_empty";

/**
 * Human-friendly operator labels for the execution view's branching tables. (The
 * Condition/Switch dialogs still hardcode their own copies — they could be
 * refactored to share this map, but that's outside this change.)
 */
export const COMPARE_OPERATOR_LABELS: Record<CompareOperator, string> = {
  contains: "Contains",
  not_contains: "Does not contain",
  equals: "Equals",
  not_equals: "Does not equal",
  greater_than: "Greater than",
  less_than: "Less than",
  is_empty: "Is empty",
  is_not_empty: "Is not empty",
};

export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

export function asString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

/**
 * Strict numeric coercion for ordering operators. `Number("")` is 0, and a
 * missing field reference renders to "" — so without the empty check a missing
 * value would satisfy `less_than 2` (0 < 2). Empty and non-numeric operands are
 * "not a number", never 0.
 */
function toNumber(value: unknown): number | null {
  const s = asString(value).trim();
  if (s === "") {
    return null;
  }
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

export function evaluateCondition(
  operator: CompareOperator,
  fieldValue: unknown,
  compareRaw: string,
): boolean {
  const sv = asString(fieldValue);

  switch (operator) {
    // An empty needle would make `contains` a tautology (`"x".includes("")` is
    // true) — typically an unresolved reference, not intent. Treat it as "no
    // match"; `not_contains` stays the exact negation so the two can never
    // disagree.
    case "contains":
      return compareRaw !== "" && sv.includes(compareRaw);
    case "not_contains":
      return compareRaw === "" || !sv.includes(compareRaw);
    case "equals":
      return sv === compareRaw;
    case "not_equals":
      return sv !== compareRaw;
    // Ordering is numeric-only: if either side is empty or non-numeric there is
    // no meaningful order, so the answer is false (no lexicographic fallback —
    // string ordering silently misranked values like "9" vs "10").
    case "greater_than": {
      const a = toNumber(fieldValue);
      const b = toNumber(compareRaw);
      return a !== null && b !== null && a > b;
    }
    case "less_than": {
      const a = toNumber(fieldValue);
      const b = toNumber(compareRaw);
      return a !== null && b !== null && a < b;
    }
    case "is_empty":
      return isEmptyValue(fieldValue);
    case "is_not_empty":
      return !isEmptyValue(fieldValue);
    default:
      return false;
  }
}
