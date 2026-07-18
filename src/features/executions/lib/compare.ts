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
 * Per-condition matching options that relax an otherwise EXACT, case-sensitive
 * comparison. Real-world inputs (form fields, sheet cells) are messy — the same
 * vehicle number arrives as `RJ-09 AB 1234`, `rj09ab1234`, `0001` vs `1` — so a
 * condition can opt into forgiving any of these axes. All default off, so an
 * unconfigured condition compares exactly as before. Shared by every node that
 * compares two values (Condition, Switch, Sheets row-match).
 */
export type CompareOptions = {
  /** Fold case before comparing, so `RJ` matches `rj`. */
  ignoreCase?: boolean;
  /**
   * Characters stripped from BOTH operands before comparing — each character in
   * the string is removed wherever it appears (put a space here to ignore
   * spaces). Lets `RJ-09 AB` match `RJ09AB` when `-` and space are neglected.
   */
  ignoreChars?: string;
  /**
   * For equals/not_equals: compare as numbers when both sides parse as numbers,
   * so `0001` equals `1` and `1.0` equals `1`. Falls back to the (normalized)
   * string comparison when either side is not numeric.
   */
  numeric?: boolean;
};

// Operators whose comparison is textual, so case/character normalization is
// meaningful. The ordering operators are already numeric-only, and the emptiness
// checks take no comparison value — options don't apply to those.
const TEXT_COMPARE_OPERATORS = new Set<CompareOperator>([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
]);

// Operators where "compare as number" changes anything (the equality pair —
// greater/less are always numeric already).
const NUMERIC_OPTION_OPERATORS = new Set<CompareOperator>([
  "equals",
  "not_equals",
]);

/** Whether case/character-ignore options apply to this operator (drives the UI). */
export function supportsTextOptions(operator: string): boolean {
  return TEXT_COMPARE_OPERATORS.has(operator as CompareOperator);
}

/** Whether the numeric-compare option applies to this operator (drives the UI). */
export function supportsNumericOption(operator: string): boolean {
  return NUMERIC_OPTION_OPERATORS.has(operator as CompareOperator);
}

/**
 * Pulls the (optional) compare options off any condition-like config object, so
 * every caller builds the same shape rather than hand-assembling it. The three
 * fields live directly on the Condition data, each Switch case, and each Sheets
 * row condition.
 */
export function pickCompareOptions(cfg: {
  ignoreCase?: boolean;
  ignoreChars?: string;
  numeric?: boolean;
}): CompareOptions {
  return {
    ignoreCase: cfg.ignoreCase,
    ignoreChars: cfg.ignoreChars,
    numeric: cfg.numeric,
  };
}

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

/**
 * A short, human-readable summary of the active options for the run detail view,
 * e.g. `case-insensitive · ignoring "- " · as number`. Empty when none are
 * active — nothing to show.
 *
 * Gated by `operator` so it only lists options the executor ACTUALLY applied:
 * case/character options are inert on ordering, emptiness, `in_list` and date
 * operators, and `numeric` is inert on anything but equals/not_equals. Reporting
 * an option the comparison ignored would mislead a user debugging a mismatch.
 * When `operator` is omitted, every set option is listed (no gating).
 */
export function describeCompareOptions(
  options: CompareOptions | undefined,
  operator?: string,
): string {
  if (!options) return "";
  const textOk = operator === undefined || supportsTextOptions(operator);
  const numOk = operator === undefined || supportsNumericOption(operator);
  const parts: string[] = [];
  if (textOk && options.ignoreCase) parts.push("case-insensitive");
  if (textOk && options.ignoreChars)
    parts.push(`ignoring "${options.ignoreChars}"`);
  if (numOk && options.numeric) parts.push("as number");
  return parts.join(" · ");
}

/** Removes every character listed in `chars` from `s` (the "neglect" option). */
function stripChars(s: string, chars: string): string {
  if (!chars) return s;
  const drop = new Set(chars);
  let out = "";
  for (const ch of s) {
    if (!drop.has(ch)) out += ch;
  }
  return out;
}

/** Applies character-strip then case-fold to one operand (both optional). */
function normalizeOperand(value: string, options?: CompareOptions): string {
  let v = value;
  if (options?.ignoreChars) v = stripChars(v, options.ignoreChars);
  if (options?.ignoreCase) v = v.toLowerCase();
  return v;
}

/**
 * Numeric equality that stays EXACT for integers of any length. `Number()`
 * collapses values past 2^53 — two different 17-digit IDs would compare equal —
 * so integer operands are compared with BigInt, digit for digit. Non-integers
 * (decimals, exponents) fall back to float equality (`1.0` == `1`,
 * `1e3` == `1000`). Returns null when either side isn't a number, so the caller
 * falls back to a string comparison.
 */
function numericEquals(a: string, b: string): boolean | null {
  const sa = a.trim();
  const sb = b.trim();
  if (sa === "" || sb === "") return null;
  const INTEGER = /^[+-]?\d+$/;
  if (INTEGER.test(sa) && INTEGER.test(sb)) return BigInt(sa) === BigInt(sb);
  const na = Number(sa);
  const nb = Number(sb);
  if (Number.isNaN(na) || Number.isNaN(nb)) return null;
  return na === nb;
}

/**
 * Equality with options. Numeric mode wins only when BOTH sides are numbers
 * (so `0001` === `1`); otherwise it falls back to the normalized string compare,
 * which is also what a plain (optionless) equals reduces to.
 */
function equalsWithOptions(
  a: string,
  b: string,
  options?: CompareOptions,
): boolean {
  if (options?.numeric) {
    const eq = numericEquals(a, b);
    if (eq !== null) return eq;
  }
  return normalizeOperand(a, options) === normalizeOperand(b, options);
}

export function evaluateCondition(
  operator: CompareOperator,
  fieldValue: unknown,
  compareRaw: string,
  options?: CompareOptions,
): boolean {
  const sv = asString(fieldValue);

  switch (operator) {
    // An empty needle would make `contains` a tautology (`"x".includes("")` is
    // true) — typically an unresolved reference, not intent. Treat it as "no
    // match"; `not_contains` stays the exact negation so the two can never
    // disagree. The guard is on the NORMALIZED needle, so a needle that strips
    // to "" (e.g. neglecting the only character in it) is a no-match too.
    case "contains": {
      const hay = normalizeOperand(sv, options);
      const needle = normalizeOperand(compareRaw, options);
      return needle !== "" && hay.includes(needle);
    }
    case "not_contains": {
      const hay = normalizeOperand(sv, options);
      const needle = normalizeOperand(compareRaw, options);
      return needle === "" || !hay.includes(needle);
    }
    case "equals":
      return equalsWithOptions(sv, compareRaw, options);
    case "not_equals":
      return !equalsWithOptions(sv, compareRaw, options);
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
