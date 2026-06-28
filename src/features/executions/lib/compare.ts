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

export function evaluateCondition(
  operator: CompareOperator,
  fieldValue: unknown,
  compareRaw: string,
): boolean {
  const sv = asString(fieldValue);

  switch (operator) {
    case "contains":
      return sv.includes(compareRaw);
    case "not_contains":
      return !sv.includes(compareRaw);
    case "equals":
      return sv === compareRaw;
    case "not_equals":
      return sv !== compareRaw;
    case "greater_than": {
      const a = Number(fieldValue);
      const b = Number(compareRaw);
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        return a > b;
      }
      return sv > compareRaw;
    }
    case "less_than": {
      const a = Number(fieldValue);
      const b = Number(compareRaw);
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        return a < b;
      }
      return sv < compareRaw;
    }
    case "is_empty":
      return isEmptyValue(fieldValue);
    case "is_not_empty":
      return !isEmptyValue(fieldValue);
    default:
      return false;
  }
}
