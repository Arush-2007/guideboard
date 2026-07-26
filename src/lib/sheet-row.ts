import { parseCustomFeatureToken } from "./custom-feature-token";
import { stripTextForcing, toSheetsCellText } from "./sheet-cells";
import { sanitizeHeaderKey } from "./sheet-headers";
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
  forceTextIds,
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
   * Force EVERY padded id in the row to text, so Google Sheets (USER_ENTERED)
   * keeps its leading zeros instead of re-parsing "0006" to 6. Applies to a
   * generated serial AND to a padded value referenced in from elsewhere (e.g.
   * `@<Sheet_A.rowByHeader.Job No>@`) — the latter is why a job number used to
   * arrive in a second sheet as "9". Sheets sets this; Excel (raw Graph write,
   * where an apostrophe would be literal) leaves it off. See
   * `toSheetsCellValue`.
   */
  forceTextIds?: boolean;
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
    const token = parseCustomFeatureToken(mapping);

    let cell: string;
    if (token?.featureId === "serialNumber") {
      // 1. Serial Number custom feature — intercept the token before templating
      //    (an unhandled `@<custom:…>@` would otherwise render to "").
      const start = toInt(token.params.start, 1);
      const pad = toInt(token.params.pad, 0);
      const next = nextSerialValue(rows, i, start);
      cell = pad > 0 ? String(next).padStart(pad, "0") : String(next);
    } else if (mapping?.trim()) {
      // 2. A mapped template value.
      cell = renderTemplate(mapping, context);
    } else if (legacyHeaderSerial && isSerialHeader(header)) {
      // 3. Legacy header-name serial (Excel only).
      cell = String((legacyRowCount ?? 0) + 1);
    } else {
      cell = "";
    }

    // ONE text-forcing rule for the whole row, applied after the value is built
    // — a padded id is a padded id whether this node generated it as a serial or
    // referenced it in from another sheet.
    return forceTextIds ? toSheetsCellText(cell) : cell;
  });
}

/**
 * Names of the `required` headers whose corresponding cell in `row` is blank
 * (empty or whitespace only). Header matching is trim-tolerant so it lines up
 * with the trimmed headers `readSheetTable` returns. A Serial Number cell is
 * always populated, so it can never appear here.
 */
export function findBlankRequired(
  headers: string[],
  row: string[],
  required: string[] | undefined,
): string[] {
  if (!required?.length) return [];
  const req = new Set(required.map((r) => r.trim()));
  const blanks: string[] = [];
  headers.forEach((rawHeader, i) => {
    const header = rawHeader.trim();
    if (req.has(header) && !(row[i] ?? "").trim()) blanks.push(header);
  });
  return blanks;
}

/**
 * The written row as an object keyed by sanitized header — the node's
 * `rowByHeader` output, so downstream nodes pick columns instead of hand-typing
 * paths.
 *
 * Any padded id written as force-text (`'0006`) carries a leading apostrophe
 * that Sheets consumes on write; it is a write artifact, so `stripTextForcing`
 * removes it here. It is deliberately NOT keyed off the column's mapping: a
 * padded value referenced in from another sheet is force-written too, and the
 * old mapping-based check only recognised a generated serial — which is exactly
 * how `'0009` could leak downstream (or the padding be lost).
 */
export function buildRowByHeader(
  headers: string[],
  row: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((rawHeader, i) => {
    out[sanitizeHeaderKey(rawHeader.trim())] = stripTextForcing(row[i] ?? "");
  });
  return out;
}
