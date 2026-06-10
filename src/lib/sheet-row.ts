import { renderTemplate } from "./templating";

/**
 * Builds a spreadsheet row for the Google Sheets "append row" action from the
 * "match the columns" mapping. The row is ordered to match the sheet's live
 * header row, so column order/additions in the sheet are respected without the
 * user re-configuring the node.
 *
 * For each header:
 *  - if the user mapped a value (a template string, possibly with `!#...#!`),
 *    it is rendered against the workflow context;
 *  - else if the header looks like a serial-number column AND was left
 *    unmapped, it is auto-filled with the next row number;
 *  - else the cell is left empty.
 */

// Matches "S.No", "Sr No", "Serial", "Serial No", "Serial Number", "Sno", "#".
const SERIAL_HEADER_RE =
  /^(?:#|s\.?\s*no\.?|sr\.?\s*no\.?|sno|serial(?:\s*(?:no\.?|number))?)$/i;

export function isSerialHeader(header: string): boolean {
  return SERIAL_HEADER_RE.test(header.trim());
}

export function buildSheetRow({
  headers,
  mappings,
  context,
  currentDataRowCount,
}: {
  headers: string[];
  mappings: Record<string, string>;
  context: Record<string, unknown>;
  /** Number of existing data rows (excluding the header row). */
  currentDataRowCount: number;
}): string[] {
  return headers.map((rawHeader) => {
    const header = rawHeader.trim();
    const template = mappings[header];

    if (template && template.trim()) {
      return renderTemplate(template, context);
    }

    if (isSerialHeader(header)) {
      return String(currentDataRowCount + 1);
    }

    return "";
  });
}
