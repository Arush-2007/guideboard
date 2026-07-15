import { NonRetriableError, RetryAfterError } from "inngest";
import { HTTPError, type Options as KyOptions } from "ky";
import { HTTP_TIMEOUT, http, rethrowTimeout } from "./http";

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
 * Reads a tab's used range (default `A:ZZ`) into a header/rows table. The header
 * row is trimmed; data rows are string-normalized and aligned to the header
 * width. The `{ headers, rows }` shape feeds `buildSheetRow` directly, and
 * `rowsByHeader` feeds `matchRows` / downstream `rowByHeader` outputs.
 */
export async function readSheetTable({
  accessToken,
  spreadsheetId,
  sheetName,
  range = "A:ZZ",
}: {
  accessToken: string;
  spreadsheetId: string;
  sheetName: string;
  range?: string;
}): Promise<SheetTable> {
  const res = await http
    .get(sheetsValuesUrl(spreadsheetId, sheetRange(sheetName, range)), {
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

type SheetsMetaResponse = {
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
      gridProperties?: { rowCount?: number };
    };
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
};

/**
 * Resolves a tab's `sheetId` + grid height. Case-insensitive title match.
 * Throws NonRetriableError if the tab is absent (a config error, not transient).
 */
export async function getSheetGrid({
  accessToken,
  spreadsheetId,
  sheetName,
}: {
  accessToken: string;
  spreadsheetId: string;
  sheetName: string;
}): Promise<SheetGrid> {
  const meta = await http
    .get(`${SHEETS_BASE}/${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      searchParams: {
        fields: "sheets.properties(sheetId,title,gridProperties.rowCount)",
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
  };
}

/**
 * Every Sheets WRITE goes through here — one clock, one timeout policy, one place
 * to change it.
 *
 * The write REQUESTS live in the action executor (they are branch-specific: append,
 * batchUpdate, values:batchUpdate), but their HTTP POLICY must not be scattered
 * across six call sites — that is exactly how the 10s default went unnoticed for
 * so long. A write's timeout is deliberately NON-retriable; see `SHEETS_WRITE`.
 */
export function sheetsWrite(
  url: string,
  options: Omit<KyOptions, "timeout">,
): Promise<Response> {
  return http
    .post(url, { ...options, timeout: HTTP_TIMEOUT.WRITE })
    .catch(rethrowTimeout({ integration: "Google Sheets", ...SHEETS_WRITE }));
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
