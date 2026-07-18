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

/** A plain number with no padding — "12", "-3.5". */
function isNumericString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * A numeric-looking value whose LEADING ZERO carries meaning — "0001" (a job
 * number), "007". Storing it as a number would silently destroy the padding, so
 * every write path has to keep it as text.
 */
export function isPaddedNumberId(value: string): boolean {
  const trimmed = value.trim();
  return isNumericString(trimmed) && /^-?0\d/.test(trimmed);
}

/**
 * Coerces a cell string onto what a spreadsheet should store: numeric-looking
 * values become numbers (so SUM / number formats see them), but leading-zero
 * ids ("0001", a job number) and non-numeric strings stay text.
 */
export function coerceCellValue(value: string): string | number {
  const trimmed = value.trim();
  if (!isNumericString(trimmed)) return value;
  if (isPaddedNumberId(trimmed)) return value;
  return Number(trimmed);
}

/**
 * Encodes a cell for a Google Sheets **USER_ENTERED** write.
 *
 * USER_ENTERED parses every value "as if typed", so the string "0009" is stored
 * as the NUMBER 9 and the padding is gone — verified against the live API:
 *
 *     sent   ["0009", "'0009", 9]
 *     stored [  9   , "0009" , 9]
 *
 * A leading apostrophe is Sheets' own force-as-text escape and is consumed on
 * write, so `'0009` stores the text "0009". Applying it to EVERY padded id (not
 * just a generated serial) is what keeps a job number intact when one sheet's
 * value is referenced into another.
 *
 * Excel does NOT use this: its Graph write stores values verbatim, where an
 * apostrophe would land in the cell literally. Excel keeps `coerceCellValue`.
 *
 * A padded id is TRIMMED on the way out (" 0009 " ⇒ `'0009`) — surrounding
 * whitespace on an id is never meaningful, and `' 0009 ` would store the spaces
 * as part of the text. Every other value is passed through untouched, because
 * whitespace in free text may well be intended. So this normalizes ids only, and
 * `stripTextForcing(toSheetsCellText(x))` returns x for an already-trimmed x.
 */
export function toSheetsCellText(value: string): string {
  return isPaddedNumberId(value) ? `'${value.trim()}` : value;
}

/**
 * As `toSheetsCellText`, but for the write paths whose payload may carry real
 * JSON numbers (update_row's ValueRange). A clean numeric still becomes a
 * NUMBER — so SUM and number formats see it — while a padded id becomes forced
 * text. One rule (`isPaddedNumberId`), two shapes: the row builder needs
 * `string[]`, an update's ValueRange does not.
 */
export function toSheetsCellValue(value: string): string | number {
  if (isPaddedNumberId(value)) return toSheetsCellText(value);
  return coerceCellValue(value);
}

/**
 * Removes the force-as-text apostrophe this app adds on write, so a value read
 * back into a workflow (`rowByHeader`) is the clean "0009" a user expects rather
 * than "'0009". Only strips when what follows is a padded id — a literal
 * apostrophe a user actually mapped ("'quoted") is preserved.
 */
export function stripTextForcing(cell: string): string {
  return cell.startsWith("'") && isPaddedNumberId(cell.slice(1))
    ? cell.slice(1)
    : cell;
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
