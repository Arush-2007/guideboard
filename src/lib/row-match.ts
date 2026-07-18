import {
  evaluateCondition,
  pickCompareOptions,
} from "@/features/executions/lib/compare";
import {
  isActiveRowCondition,
  type RowMatchOperator,
} from "@/lib/row-match-operators";
import { renderTemplate } from "@/lib/templating";

export type { RowMatchOperator };

/**
 * Shared row matcher for the Sheets `find_rows` and `color_rows` actions. Rows
 * are header-keyed objects (see `readSheetTable().rowsByHeader`); a row matches
 * when it satisfies ALL enabled conditions (AND semantics).
 *
 * The operator set is the branching nodes' 8 (delegated to `evaluateCondition`)
 * PLUS three selection-only additions — `older_than_days`, `within_days`,
 * `in_list` — scoped to row *selection* (v3 decision #6). The compare/switch
 * dialogs are intentionally NOT widened here. The operator type + labels live in
 * the dependency-free `row-match-operators.ts` (single source; client-safe).
 */

export type RowMatchCondition = {
  /** Stable UI key for the conditions editor; ignored by the matcher. */
  id?: string;
  column: string;
  operator: RowMatchOperator;
  /** Comparison value; rendered against the workflow context before compare. */
  value?: string;
  /** Defaults to enabled; only `enabled === false` is skipped. */
  enabled?: boolean;
  // Matching options (see `CompareOptions`) — relax the base string operators
  // per-condition. Ignored by the selection-only operators (in_list already
  // lowercases; the date operators are numeric).
  ignoreCase?: boolean;
  ignoreChars?: string;
  numeric?: boolean;
};

export type RowMatch = { index: number; row: Record<string, string> };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Case-insensitive cell lookup within a header-keyed row; "" if the column is absent. */
export function getRowCell(
  row: Record<string, string>,
  column: string,
): string {
  const target = column.trim().toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.trim().toLowerCase() === target) return row[key] ?? "";
  }
  return "";
}

/**
 * Parses an `in_list` comparison value: a JSON array first (`["A","B"]` — the
 * form emitted by `find_rows.columnValues`, safe for values containing commas),
 * else a comma-separated list. Entries are trimmed; blanks dropped.
 */
function parseList(rendered: string): string[] {
  const trimmed = rendered.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v ?? "").trim()).filter(Boolean);
    }
  } catch {
    // not JSON — fall through to comma-split
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isInList(cell: string, rendered: string): boolean {
  const needle = cell.trim().toLowerCase();
  if (!needle) return false;
  return parseList(rendered).some((v) => v.toLowerCase() === needle);
}

/**
 * Lenient date parse. Reliable for ISO dates/timestamps (`2026-01-31`,
 * `2026-01-31T09:00:00Z`) and `2026/01/31`. Ambiguous day-first formats
 * (`31-01-2026`) are NOT supported — document the expected column format.
 */
function parseDate(value: string): number | null {
  const s = value.trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function ageMs(cell: string, now: number): number | null {
  const t = parseDate(cell);
  return t === null ? null : now - t;
}

/** True when the cell's date is at least N days in the past (exactly N ⇒ older). */
function isOlderThanDays(cell: string, days: string, now: number): boolean {
  const n = Number(days.trim());
  if (!Number.isFinite(n)) return false;
  const age = ageMs(cell, now);
  return age !== null && age >= n * MS_PER_DAY;
}

/** True when the cell's date is less than N days in the past (the boundary is "older"). */
function isWithinDays(cell: string, days: string, now: number): boolean {
  const n = Number(days.trim());
  if (!Number.isFinite(n)) return false;
  const age = ageMs(cell, now);
  return age !== null && age < n * MS_PER_DAY;
}

export function evaluateRowCondition(
  row: Record<string, string>,
  condition: RowMatchCondition,
  context: Record<string, unknown>,
  now: number = Date.now(),
): boolean {
  const cell = getRowCell(row, condition.column);
  const rendered = renderTemplate(condition.value ?? "", context);
  switch (condition.operator) {
    case "older_than_days":
      return isOlderThanDays(cell, rendered, now);
    case "within_days":
      return isWithinDays(cell, rendered, now);
    case "in_list":
      return isInList(cell, rendered);
    default:
      return evaluateCondition(
        condition.operator,
        cell,
        rendered,
        pickCompareOptions(condition),
      );
  }
}

function activeConditions(
  conditions: RowMatchCondition[],
): RowMatchCondition[] {
  return conditions.filter(isActiveRowCondition);
}

/**
 * Returns the rows matching ALL enabled conditions (AND). `index` is the 0-based
 * data-row index (sheet row = index + 2, after the header). An empty / all-
 * disabled condition set matches EVERY row (vacuous AND) — callers that must not
 * act on all rows (e.g. color target "match") should guard for that themselves.
 */
export function matchRows(
  rows: Array<Record<string, string>>,
  conditions: RowMatchCondition[],
  context: Record<string, unknown>,
  now: number = Date.now(),
): RowMatch[] {
  const active = activeConditions(conditions);
  const matches: RowMatch[] = [];
  rows.forEach((row, index) => {
    if (active.every((c) => evaluateRowCondition(row, c, context, now))) {
      matches.push({ index, row });
    }
  });
  return matches;
}
