import { parseCustomFeatureToken } from "./custom-feature-token";
import { renderTemplate } from "./templating";

/**
 * Builds a spreadsheet row for the Google Sheets "append row" action from the
 * "match the columns" mapping. The row is ordered to match the sheet's live
 * header row, so column order/additions in the sheet are respected without the
 * user re-configuring the node.
 *
 * For each header:
 *  - if the mapping is a "Serial Number" custom-feature token, the cell is
 *    auto-filled with the next number (max existing + 1, floored at the token's
 *    `start`), zero-padded to the token's `pad` width;
 *  - else if the user mapped a value (a template string, possibly with
 *    `@<...>@`), it is rendered against the workflow context;
 *  - else (legacy, Excel-only) if `legacyHeaderSerial` is set and the header
 *    looks like a serial column left unmapped, it is auto-filled by row count;
 *  - else the cell is left empty.
 */

// Legacy header-name serial detection — used ONLY by the on-halt Excel action
// (behind `legacyHeaderSerial`). New Sheets serials are opt-in via the Serial
// Number custom feature, so no Sheets column auto-fills by header name.
// Matches "S.No", "Sr No", "Serial", "Serial No", "Serial Number", "Sno", "#".
const SERIAL_HEADER_RE =
  /^(?:#|s\.?\s*no\.?|sr\.?\s*no\.?|sno|serial(?:\s*(?:no\.?|number))?)$/i;

export function isSerialHeader(header: string): boolean {
  return SERIAL_HEADER_RE.test(header.trim());
}

function toInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Next value for an auto-incrementing serial column: `max(existing numeric in
 * that column) + 1`, but never below `start`. Robust to deleted rows, which a
 * plain row count would let collide. Falls back to `start` when the column has
 * no numeric values yet (or no rows were supplied).
 */
function nextSerialValue(
  rows: string[][] | undefined,
  columnIndex: number,
  start: number,
): number {
  let max = Number.NEGATIVE_INFINITY;
  if (rows) {
    for (const row of rows) {
      const parsed = Number.parseInt(String(row[columnIndex] ?? "").trim(), 10);
      if (Number.isFinite(parsed) && parsed > max) max = parsed;
    }
  }
  return Number.isFinite(max) ? Math.max(max + 1, start) : start;
}

export function buildSheetRow({
  headers,
  mappings,
  context,
  rows,
  serialAsText,
  legacyHeaderSerial,
  legacyRowCount,
}: {
  headers: string[];
  mappings: Record<string, string>;
  context: Record<string, unknown>;
  /**
   * Existing data rows (header-aligned, excluding the header row). Used to
   * compute a Serial Number column's max(existing)+1.
   */
  rows?: string[][];
  /**
   * Prefix a *padded* serial with a text-forcing apostrophe so Google Sheets
   * (USER_ENTERED) keeps its leading zeros instead of re-parsing "0006" to 6.
   * Sheets sets this; Excel (raw Graph write) leaves it off.
   */
  serialAsText?: boolean;
  /**
   * Legacy header-name serial autofill (Excel action, on halt). When true, an
   * unmapped column whose header looks like a serial ("S.No", …) is filled with
   * `legacyRowCount + 1`. Off for Sheets, which uses the Serial Number feature.
   */
  legacyHeaderSerial?: boolean;
  /** Row count used only by the legacy header-name serial path. */
  legacyRowCount?: number;
}): string[] {
  return headers.map((rawHeader, i) => {
    const header = rawHeader.trim();
    const mapping = mappings[header];

    // 1. Serial Number custom feature — intercept the token before templating
    //    (an unhandled `@<custom:…>@` would otherwise render to "").
    const token = parseCustomFeatureToken(mapping);
    if (token?.featureId === "serialNumber") {
      const start = toInt(token.params.start, 1);
      const pad = toInt(token.params.pad, 0);
      const next = nextSerialValue(rows, i, start);
      const value = pad > 0 ? String(next).padStart(pad, "0") : String(next);
      // Leading apostrophe keeps Sheets from stripping the zeros (see param doc).
      return serialAsText && pad > 0 ? `'${value}` : value;
    }

    // 2. A mapped template value.
    if (mapping?.trim()) {
      return renderTemplate(mapping, context);
    }

    // 3. Legacy header-name serial (Excel only).
    if (legacyHeaderSerial && isSerialHeader(header)) {
      return String((legacyRowCount ?? 0) + 1);
    }

    return "";
  });
}
