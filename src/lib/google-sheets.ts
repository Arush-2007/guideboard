import { NonRetriableError, RetryAfterError } from "inngest";
import { HTTPError, type Options as KyOptions } from "ky";
import { HTTP_TIMEOUT, http, rethrowTimeout } from "./http";
import { type HeadingFormat, resolveHeadingFormat } from "./sheet-heading";

/**
 * Shared Google Sheets v4 REST plumbing — the Sheets counterpart of
 * `src/lib/ms-graph.ts`. Every Sheets executor branch (append, find_rows,
 * update, insert-adjacent, color) reads/writes through these helpers so URL,
 * auth-header, table-parsing and error-mapping logic lives in exactly one place.
 */

export const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * The timeout classes every Sheets call names, and what a user can do when one
 * fires. Exported because the WRITES live in the action executor while the READS
 * live here — both must classify identically or the same failure reads two ways.
 *
 * A read is retriable; a WRITE IS NOT — a timed-out `values:append` may have
 * landed, and retrying it appends the row twice. See `TIMEOUT_RETRIABLE` in
 * `http.ts` for the full trade-off.
 */
export const SHEETS_READ = {
  timeoutClass: "READ",
  // Reading a tab changes nothing, so Inngest may safely retry it.
  idempotent: true,
  hint: "The tab may be very large — narrow the range, or try again.",
} as const;

export const SHEETS_WRITE = {
  timeoutClass: "WRITE",
  // ⚠️ A timed-out `values:append` MAY HAVE LANDED — the response was lost, not
  // necessarily the request. Retrying it would append the row a SECOND time, and a
  // silent duplicate row in a client's ledger is far worse than a visible failure.
  idempotent: false,
  hint: "The sheet may be very large, or Google may be slow right now.",
} as const;

export const SHEETS_ABSOLUTE_WRITE = {
  timeoutClass: "WRITE",
  // Writes each cell's FINAL state to a FIXED target — its value via
  // values:batchUpdate, or its FORMAT via a repeatCell batchUpdate (color_rows).
  // A retry rewrites the identical cells, so Inngest may safely retry — unlike
  // :append and insertDimension, which ADD rows/dimensions and stay
  // idempotent:false.
  idempotent: true,
  hint: "The sheet may be very large, or Google may be slow right now.",
} as const;

/** Bearer auth headers for a JSON request. */
export function sheetsAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

/** URL for a values range (A1 notation) — used by GET, :append and PUT/update. */
export function sheetsValuesUrl(
  spreadsheetId: string,
  a1Range: string,
): string {
  return `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(a1Range)}`;
}

/**
 * A1 notation for a range on a named tab, with the tab name QUOTED.
 *
 * Sheets requires quotes as soon as a tab name contains a space or other
 * non-alphanumeric character — `Job Cards!A:ZZ` is rejected with a 400
 * "Unable to parse range", which surfaces as a NonRetriableError and simply
 * breaks the node. Quoting is ALWAYS valid (`'Sheet1'!A1` == `Sheet1!A1`), so
 * quote unconditionally rather than trying to guess when it is needed.
 *
 * An apostrophe inside the name is escaped by doubling it, per A1 notation:
 * a tab called `Bob's Jobs` becomes `'Bob''s Jobs'`.
 *
 * EVERY range this app sends to Sheets must be built here.
 */
export function sheetRange(sheetName: string, range: string): string {
  return `'${sheetName.trim().replace(/'/g, "''")}'!${range}`;
}

/** URL for spreadsheets.batchUpdate (structural + formatting edits). */
export function sheetsBatchUpdateUrl(spreadsheetId: string): string {
  return `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`;
}

/**
 * URL for spreadsheets.values.batchUpdate — writes N ValueRanges in ONE call.
 * Distinct from `sheetsBatchUpdateUrl` (which carries structural/format
 * requests). Used by update_row to write every matched row in one request,
 * and by the single-match path too, so there is one write code path.
 */
export function sheetsValuesBatchUpdateUrl(spreadsheetId: string): string {
  return `${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`;
}

type SheetsValuesResponse = { values?: unknown[][] };

export type SheetTable = {
  /** Trimmed header names from row 1, in sheet order. */
  headers: string[];
  /** Data rows (row 2+), header-aligned, every cell stringified. */
  rows: string[][];
  /** Each data row as an object keyed by its trimmed header (blank ⇒ colN). */
  rowsByHeader: Array<Record<string, string>>;
};

/**
 * Reads a tab into a header/rows table. The header row is trimmed; data rows are
 * string-normalized and aligned to the header width. The `{ headers, rows }`
 * shape feeds `buildSheetRow` directly, and `rowsByHeader` feeds `matchRows` /
 * downstream `rowByHeader` outputs.
 *
 * The range is FIXED to the whole tab (`A:ZZ`) rather than being a parameter:
 * `nextFreeSheetRow` derives an absolute row number from `rows.length`, which is
 * only meaningful when row 1 is the header and the rows are the whole tab. A
 * caller reading a sub-range (`A10:ZZ`) would compute a row number 9 too high
 * and overwrite live data, so the option is deliberately not offered.
 */
export async function readSheetTable({
  accessToken,
  spreadsheetId,
  sheetName,
}: {
  accessToken: string;
  spreadsheetId: string;
  sheetName: string;
}): Promise<SheetTable> {
  const res = await http
    .get(sheetsValuesUrl(spreadsheetId, sheetRange(sheetName, "A:ZZ")), {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: HTTP_TIMEOUT.READ,
    })
    .json<SheetsValuesResponse>()
    .catch(rethrowTimeout({ integration: "Google Sheets", ...SHEETS_READ }));

  const raw = res.values ?? [];
  const headers = (raw[0] ?? []).map((h) => String(h ?? "").trim());
  const rows = raw
    .slice(1)
    .map((row) => headers.map((_h, i) => String(row[i] ?? "")));
  const rowsByHeader = rows.map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h || `col${i + 1}`] = row[i] ?? "";
    });
    return obj;
  });
  return { headers, rows, rowsByHeader };
}

/**
 * The 1-based sheet row a NEW row should occupy: the first free row under the
 * table. `readSheetTable` always reads the WHOLE tab (its range is fixed, not a
 * parameter — see there) and returns every row up to the last non-empty one,
 * with row 1 the header. So the next free row is exactly `rows.length + 2`.
 *
 * ⚠️ Row placement is computed HERE and written to an ABSOLUTE range — never via
 * `values:append`. Append picks its own destination by "finding a table" in the
 * range, and that heuristic is unsafe in four ways:
 *   1. it mis-anchors the COLUMN when the payload's first row is empty, writing
 *      the row shifted right (and the offset compounds on later appends);
 *   2. it ignores trailing blank rows, so a blank row can never be appended and
 *      the next append lands on top of one;
 *   3. a lost-response retry appends the row a SECOND time (see SHEETS_WRITE);
 *   4. the caller can only guess where the row landed, so a reported row number
 *      may be wrong.
 * An absolute range has none of these failure modes and is retry-safe.
 */
export function nextFreeSheetRow(table: SheetTable): number {
  return table.rows.length + 2;
}

/** A merged range as Sheets reports it (half-open, 0-based grid indexes). */
export type SheetMergeRange = {
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
};

type SheetsMetaResponse = {
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
      gridProperties?: { rowCount?: number };
    };
    merges?: SheetMergeRange[];
  }>;
};

export type SheetGrid = {
  /** batchUpdate addresses sheets by id, not name. */
  sheetId: number;
  /**
   * How many rows the GRID has — not how many hold data. `insertDimension` can
   * only address rows that exist, so a caller inserting near the bottom of a
   * trimmed sheet must grow the grid (`appendDimension`) first.
   */
  rowCount: number;
  /**
   * Every merged range on the tab. This is what makes a HEADING row identifiable
   * with certainty rather than by guesswork — see `headingDataRows`.
   *
   * ⚠️ `[]` unless the call passed `includeMerges: true`. An empty array from a
   * default call means "not requested", NOT "this tab has none".
   */
  merges: SheetMergeRange[];
};

/**
 * The heading rows of a tab: DATA-row index (0-based, as in `SheetTable.rows`)
 * → how many columns that heading is actually MERGED across.
 *
 * A heading is identified by the one thing that is true of it and of nothing
 * else: its cells are MERGED, starting at column A, across a single row. That
 * comes from the sheet's own structure, so a genuine data row that merely
 * happens to have only its first column filled is never mistaken for one — which
 * a "first cell filled, rest empty" heuristic would get wrong, and silently.
 *
 * A Map rather than a Set because the WIDTH is load-bearing, not incidental: a
 * heading merged when the tab had 3 columns stays 3 wide after a 4th is added,
 * and anything re-merging it must use the width it actually has. Merging a range
 * that overlaps an existing merge is rejected by Sheets, so re-deriving the width
 * from today's header row would fail the write. `.has()` and `.size` read the
 * same as on a Set, so membership callers are unaffected.
 *
 * Grid row 0 is the header, so data row i is grid row i + 1; anything at or above
 * the header is ignored (a merged header is not a heading).
 */
export function headingDataRows(
  merges: SheetMergeRange[],
): Map<number, number> {
  const rows = new Map<number, number>();
  for (const m of merges) {
    const start = m.startRowIndex ?? 0;
    const end = m.endRowIndex ?? start + 1;
    // Anchored at column A, exactly one row tall, below the header row.
    if ((m.startColumnIndex ?? 0) !== 0) continue;
    if (end - start !== 1) continue;
    if (start < 1) continue;
    rows.set(start - 1, m.endColumnIndex ?? 0);
  }
  return rows;
}

/**
 * Resolves a tab's `sheetId` + grid height. Case-insensitive title match.
 * Throws NonRetriableError if the tab is absent (a config error, not transient).
 */
export async function getSheetGrid({
  accessToken,
  spreadsheetId,
  sheetName,
  includeMerges = false,
}: {
  accessToken: string;
  spreadsheetId: string;
  sheetName: string;
  /**
   * Also fetch the tab's merged ranges (`merges`), which is what identifies
   * heading rows. OFF by default: most callers here only want `sheetId` +
   * `rowCount` — every append goes through `ensureGridRows`, and the whiten /
   * heading-style / color paths all need the id alone. A workbook of report
   * tabs can carry thousands of merge objects, and pulling them on every append
   * would put that on the hot write path for nothing.
   *
   * Only the row-reading path, which must tell headings from data, asks for
   * them. `merges` is `[]` when this is off — never trust it as "no merges"
   * unless you requested them.
   */
  includeMerges?: boolean;
}): Promise<SheetGrid> {
  const meta = await http
    .get(`${SHEETS_BASE}/${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      searchParams: {
        // One `sheets(...)` group listing every sub-field. The equivalent
        // `sheets.properties(...),sheets.merges` form works identically —
        // verified against the live API with `scripts/dump-sheet-merges.ts`,
        // which returns the same payload for both and for no mask at all. This
        // form is preferred only because naming the parent once makes it obvious
        // that adding a sub-field means editing one group.
        fields: includeMerges
          ? "sheets(properties(sheetId,title,gridProperties.rowCount),merges)"
          : "sheets(properties(sheetId,title,gridProperties.rowCount))",
      },
      timeout: HTTP_TIMEOUT.READ,
    })
    .json<SheetsMetaResponse>()
    .catch(rethrowTimeout({ integration: "Google Sheets", ...SHEETS_READ }));

  const target = sheetName.trim().toLowerCase();
  const found = (meta.sheets ?? []).find(
    (s) => (s.properties?.title ?? "").trim().toLowerCase() === target,
  );
  if (!found?.properties || found.properties.sheetId == null) {
    throw new NonRetriableError(
      `Google Sheets: tab "${sheetName}" was not found in the spreadsheet`,
    );
  }
  return {
    sheetId: found.properties.sheetId,
    rowCount: found.properties.gridProperties?.rowCount ?? 0,
    merges: found.merges ?? [],
  };
}

/**
 * Grows the tab's GRID until `throughRow` exists, so an absolute-range write to
 * that row can't fall outside the sheet (`values:batchUpdate` does NOT expand a
 * sheet the way `:append` does — it fails). A no-op when the grid is already tall
 * enough, which is the common case for a default 1000-row tab; it matters for a
 * sheet a user has trimmed down to its data.
 *
 * Growing by a few extra rows is harmless (they are empty), so a retry that grows
 * again cannot corrupt anything.
 */
export async function ensureGridRows({
  accessToken,
  spreadsheetId,
  sheetName,
  throughRow,
}: {
  accessToken: string;
  spreadsheetId: string;
  sheetName: string;
  throughRow: number;
}): Promise<void> {
  const grid = await getSheetGrid({ accessToken, spreadsheetId, sheetName });
  const shortfall = throughRow - grid.rowCount;
  if (shortfall <= 0) return;
  await sheetsWrite(sheetsBatchUpdateUrl(spreadsheetId), {
    headers: sheetsAuthHeaders(accessToken),
    json: {
      requests: [
        {
          appendDimension: {
            sheetId: grid.sheetId,
            dimension: "ROWS",
            length: shortfall,
          },
        },
      ],
    },
  });
}

/**
 * Every Sheets WRITE goes through here — one clock, one place to change it.
 *
 * The write REQUESTS live in the action executor (they are branch-specific: append,
 * batchUpdate, values:batchUpdate), but their HTTP POLICY must not be scattered
 * across six call sites — that is exactly how the 10s default went unnoticed for
 * so long. The timeout is deliberately NON-retriable by DEFAULT (`SHEETS_WRITE`),
 * because most writes ADD rows and a lost-response retry would duplicate them.
 * Absolute-range writes that rewrite each cell's FINAL value (values:batchUpdate)
 * ARE retry-safe — pass `{ idempotent: true }` to opt into `SHEETS_ABSOLUTE_WRITE`.
 */
export function sheetsWrite(
  url: string,
  options: Omit<KyOptions, "timeout">,
  { idempotent = false }: { idempotent?: boolean } = {},
): Promise<Response> {
  const ctx = idempotent ? SHEETS_ABSOLUTE_WRITE : SHEETS_WRITE;
  return http
    .post(url, { ...options, timeout: HTTP_TIMEOUT.WRITE })
    .catch(rethrowTimeout({ integration: "Google Sheets", ...ctx }));
}

type SheetsErrorBody = {
  error?: { code?: number; message?: string; status?: string };
};

/**
 * Maps a Sheets HTTP failure onto Inngest retry semantics, mirroring the Excel
 * action's `toGraphError`: 429 honors Retry-After; 400/401/403/404 are config /
 * permission problems (no retry); everything else (transient 5xx) retries.
 *
 * ⚠️ The non-`HTTPError` passthrough below is LOAD-BEARING, not incidental.
 * Timeouts are classified at the call site by `rethrowTimeout` (a ky
 * `TimeoutError` is not an `HTTPError`, so it could never be classified here),
 * and they arrive already wrapped as RetryAfter/NonRetriable. This function must
 * hand them through UNTOUCHED. Re-wrapping them would erase the retry decision.
 */
export async function toSheetsError(error: unknown): Promise<Error> {
  if (!(error instanceof HTTPError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const status = error.response.status;
  let code = "";
  let detail = error.message;
  try {
    const body = (await error.response.json()) as SheetsErrorBody;
    code =
      body.error?.status ??
      (body.error?.code != null ? String(body.error.code) : "");
    detail = body.error?.message ?? detail;
  } catch {
    // non-JSON error body — keep the HTTP message
  }
  const message = `Google Sheets: ${status}${code ? ` (${code})` : ""}: ${detail}`;

  if (status === 429) {
    const retryAfter = error.response.headers.get("retry-after");
    return new RetryAfterError(message, retryAfter ? `${retryAfter}s` : "30s");
  }
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return new NonRetriableError(message);
  }
  return new Error(message);
}

export type SheetsColor = { red: number; green: number; blue: number };

/**
 * Converts `#RRGGBB` (case-insensitive, leading `#` optional) into the 0..1 RGB
 * channels that Sheets' `userEnteredFormat.backgroundColor` expects. Throws
 * NonRetriableError on a malformed hex (a config error, not transient).
 */
export function hexToRgb(hex: string): SheetsColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    throw new NonRetriableError(
      `Google Sheets: "${hex}" is not a valid #RRGGBB color`,
    );
  }
  const n = Number.parseInt(m[1], 16);
  return {
    red: ((n >> 16) & 0xff) / 255,
    green: ((n >> 8) & 0xff) / 255,
    blue: (n & 0xff) / 255,
  };
}

/** Solid white — the background every ADDED blank row is forced to. */
export const WHITE: SheetsColor = { red: 1, green: 1, blue: 1 };

/**
 * A `repeatCell` batchUpdate request that paints one row's background solid white
 * across the used-column band (columns 0..`columnCount`).
 *
 * A row this app ADDS as blank must read as an empty gap, but "blank" only means
 * no VALUES — a skipped `blankRowAbove` separator keeps whatever background sat at
 * that grid position (alternating-row banding, or a deleted colored row's
 * residue), and a blank row inserted under a group inherits the color of the row
 * above via `insertDimension`'s `inheritFromBefore`. Writing an explicit white
 * overrides both, since a cell's own `userEnteredFormat.backgroundColor` wins over
 * banding. Setting a fixed color on fixed cells is idempotent, so the write is
 * safe for Inngest to retry.
 *
 * `gridRow0` is the 0-based grid row: the header is grid row 0, so sheet row N is
 * grid row N − 1.
 */
export function whiteRowRequest(
  sheetId: number,
  gridRow0: number,
  columnCount: number,
): { repeatCell: unknown } {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: gridRow0,
        endRowIndex: gridRow0 + 1,
        startColumnIndex: 0,
        // Exclusive bound — the full header width, so the white band matches the
        // table exactly (the same bound color_rows paints to).
        endColumnIndex: columnCount,
      },
      cell: { userEnteredFormat: { backgroundColor: WHITE } },
      fields: "userEnteredFormat.backgroundColor",
    },
  };
}

/**
 * The `batchUpdate` requests that turn one freshly-written row into a HEADING:
 * the whole band styled from `format`, then merged into a single cell.
 *
 * Two requests, in this order and never separated — a merge inherits the
 * top-left cell's format, so styling first is what makes the merged band come
 * out uniform rather than carrying the old formatting of the cells it swallowed.
 *
 * `fields` names every sub-field written (rather than the whole
 * `userEnteredFormat`) so a heading row keeps the number format, borders and
 * padding of the tab it lives in; only the properties the user chose are
 * touched.
 *
 * Both requests are IDEMPOTENT: `repeatCell` sets fixed values on fixed cells,
 * and `mergeCells` over an already-identical merge is accepted and changes
 * nothing. So an Inngest retry of the step carrying them repaints and re-merges
 * to exactly the same result.
 *
 * `columnCount` is the table's width (the header row) — the same band
 * `whiteRowRequest` clears and `color_rows` paints, so a heading stops where the
 * table stops. A one-column table yields NO merge request: Sheets rejects a
 * single-cell merge, and there is nothing to span anyway.
 *
 * `gridRow0` is the 0-based grid row: the header is grid row 0, so sheet row N
 * is grid row N − 1.
 */
export function headingRowRequests({
  sheetId,
  gridRow0,
  columnCount,
  format,
}: {
  sheetId: number;
  gridRow0: number;
  columnCount: number;
  format?: HeadingFormat | null;
}): unknown[] {
  const f = resolveHeadingFormat(format);
  const range = {
    sheetId,
    startRowIndex: gridRow0,
    endRowIndex: gridRow0 + 1,
    startColumnIndex: 0,
    // Exclusive bound — the full header width.
    endColumnIndex: columnCount,
  };

  const requests: unknown[] = [
    {
      repeatCell: {
        range,
        cell: {
          userEnteredFormat: {
            backgroundColor: hexToRgb(f.backgroundColor),
            horizontalAlignment: f.align,
            verticalAlignment: "MIDDLE",
            textFormat: {
              bold: f.bold,
              italic: f.italic,
              fontSize: f.fontSize,
              foregroundColor: hexToRgb(f.textColor),
            },
          },
        },
        fields:
          "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)",
      },
    },
  ];

  if (columnCount > 1) {
    requests.push({ mergeCells: { range, mergeType: "MERGE_ALL" } });
  }

  return requests;
}
