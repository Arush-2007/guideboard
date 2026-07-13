import { NonRetriableError } from "inngest";

/**
 * Shared spreadsheet-cell numeric helpers, so the "coerce numbers but keep
 * leading-zero ids as text" rule lives in exactly one place.
 *
 * `coerceCellValue` is used by both the Excel and Google Sheets write paths.
 * `toCellNumber` (accumulate-onto-existing) currently has ONE caller — the Excel
 * action's `upsert_by_key`. The Sheets actions deliberately do no arithmetic:
 * that belongs in a dedicated node upstream, not in a write action's column
 * config. Kept here, parameterized by `errorPrefix`, for that node to reuse.
 */

/**
 * Coerces a cell string onto what a spreadsheet should store: numeric-looking
 * values become numbers (so SUM / number formats see them), but leading-zero
 * ids ("0001", a job number) and non-numeric strings stay text.
 */
export function coerceCellValue(value: string): string | number {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return value;
  if (/^-?0\d/.test(trimmed)) return value;
  return Number(trimmed);
}

/**
 * Parses a cell as a number for "add to existing" accumulation. Empty ⇒ 0;
 * thousands-separator commas are stripped. A non-numeric value throws a
 * NonRetriableError naming the column (a config error, not transient).
 * `errorPrefix` labels the message for the calling node (e.g. "Excel Action",
 * "Google Sheets Action").
 */
export function toCellNumber(
  value: unknown,
  columnName: string,
  errorPrefix = "Sheet",
): number {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const parsed = Number(raw.replace(/,/g, ""));
  if (Number.isNaN(parsed)) {
    throw new NonRetriableError(
      `${errorPrefix}: column "${columnName}" is set to "Add to existing" but holds the non-numeric value "${raw}"`,
    );
  }
  return parsed;
}
