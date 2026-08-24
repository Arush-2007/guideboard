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

// Operators compared as text, where CASE normalization is meaningful. The
// ordering pair is excluded because its operands are parsed as numbers, and the
// emptiness checks take no comparison value at all.
const CASE_OPTION_OPERATORS = new Set<CompareOperator>([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
]);

// Operators where stripping characters changes the outcome.
//
// This INCLUDES the ordering pair, and that is the whole point. Ordering parses
// both operands as numbers, so a cell holding a formatted amount — "₹18,400.00",
// "1,234", "45 kg" — parses as NaN and the comparison silently answers false.
// Neglecting the symbol and separators is what makes such a cell orderable, so
// hiding the option from the operators that most need it (as gating it on the
// text set did) left no way to compare money at all.
const CHAR_OPTION_OPERATORS = new Set<CompareOperator>([
  ...CASE_OPTION_OPERATORS,
  "greater_than",
  "less_than",
]);

// Operators where "compare as number" is a CHOICE. Ordering is always numeric,
// so the toggle would be a no-op there rather than a missing capability.
const NUMERIC_OPTION_OPERATORS = new Set<CompareOperator>([
  "equals",
  "not_equals",
]);

/** Whether the ignore-case option applies to this operator (drives the UI). */
export function supportsCaseOption(operator: string): boolean {
  return CASE_OPTION_OPERATORS.has(operator as CompareOperator);
}

/** Whether the neglect-characters option applies to this operator (drives the UI). */
export function supportsCharOption(operator: string): boolean {
  return CHAR_OPTION_OPERATORS.has(operator as CompareOperator);
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
 *
 * Normalizes BEFORE parsing. Parsing the raw operand is what made every numeric
 * comparison against a formatted cell answer false no matter which options were
 * set: `ignoreChars` was applied only on the string-comparison fallback, which
 * ordering never reaches. With no options set this is byte-identical to before.
 */
function toNumber(value: unknown, options?: CompareOptions): number | null {
  const s = normalizeForNumber(asString(value), options).trim();
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
 * case is inert on ordering and emptiness, character-neglect is inert only on
 * the emptiness checks (ordering DOES apply it — see `CHAR_OPTION_OPERATORS`),
 * and `numeric` is inert on anything but equals/not_equals. Reporting
 * an option the comparison ignored would mislead a user debugging a mismatch.
 * When `operator` is omitted, every set option is listed (no gating).
 */
export function describeCompareOptions(
  options: CompareOptions | undefined,
  operator?: string,
): string {
  if (!options) return "";
  const caseOk = operator === undefined || supportsCaseOption(operator);
  const charOk = operator === undefined || supportsCharOption(operator);
  const numOk = operator === undefined || supportsNumericOption(operator);
  const parts: string[] = [];
  if (caseOk && options.ignoreCase) parts.push("case-insensitive");
  if (charOk && options.ignoreChars)
    parts.push(`ignoring "${options.ignoreChars}"`);
  if (numOk && options.numeric) parts.push("as number");
  return parts.join(" · ");
}

/**
 * Characters `ignoreChars` must never strip when the operand is about to be
 * PARSED as a number, because removing them changes the value rather than the
 * formatting: "-5" would become 5 and invert an ordering, and "18.5" would
 * become 185.
 *
 * This matters because the option is per-condition and survives an operator
 * change — nothing clears it when a condition switches from `equals` to
 * `greater_than`, so the documented text example (`"- "`, for matching
 * "RJ-09 AB") can arrive on the numeric path without the user ever choosing it
 * there.
 */
const NUMERICALLY_SIGNIFICANT = new Set(["-", "+", "."]);

/**
 * `ignoreChars` as applied on a NUMERIC path: the listed characters minus the
 * ones that carry numeric meaning, and no case folding.
 *
 * Case is skipped deliberately rather than by omission. Lowercasing can only
 * turn a parseable token into an unparseable one ("Infinity"), never the
 * reverse, so applying it here would flip a comparison for no benefit — and
 * `describeCompareOptions` already tells the user case is inert on ordering.
 */
function normalizeForNumber(value: string, options?: CompareOptions): string {
  if (!options?.ignoreChars) return value;
  const drop = [...options.ignoreChars].filter(
    (c) => !NUMERICALLY_SIGNIFICANT.has(c),
  );
  return drop.length > 0 ? stripChars(value, drop.join("")) : value;
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
    // Normalized first, for the reason given on `toNumber`: "₹0.00" is not a
    // number until the symbol is gone, and without this the numeric branch
    // declined and fell through to comparing "0.00" with "0" as strings.
    const eq = numericEquals(
      normalizeForNumber(a, options),
      normalizeForNumber(b, options),
    );
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
      const a = toNumber(fieldValue, options);
      const b = toNumber(compareRaw, options);
      return a !== null && b !== null && a > b;
    }
    case "less_than": {
      const a = toNumber(fieldValue, options);
      const b = toNumber(compareRaw, options);
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
