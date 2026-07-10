import { NonRetriableError, RetryAfterError } from "inngest";
import ky, { HTTPError } from "ky";

/**
 * Shared Google Sheets v4 REST plumbing — the Sheets counterpart of
 * `src/lib/ms-graph.ts`. Every Sheets executor branch (append, find_rows,
 * upsert, insert-adjacent, color) reads/writes through these helpers so URL,
 * auth-header, table-parsing and error-mapping logic lives in exactly one place.
 */

export const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

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

/** URL for spreadsheets.batchUpdate (structural + formatting edits). */
export function sheetsBatchUpdateUrl(spreadsheetId: string): string {
  return `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`;
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
  const a1Range = `${sheetName}!${range}`;
  const res = await ky
    .get(sheetsValuesUrl(spreadsheetId, a1Range), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<SheetsValuesResponse>();

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
  sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
};

/**
 * Resolves a tab's numeric `sheetId` (batchUpdate addresses sheets by id, not
 * name). Case-insensitive title match. Throws NonRetriableError if absent.
 */
export async function getSheetIdByName({
  accessToken,
  spreadsheetId,
  sheetName,
}: {
  accessToken: string;
  spreadsheetId: string;
  sheetName: string;
}): Promise<number> {
  const meta = await ky
    .get(`${SHEETS_BASE}/${spreadsheetId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      searchParams: { fields: "sheets.properties(sheetId,title)" },
    })
    .json<SheetsMetaResponse>();

  const target = sheetName.trim().toLowerCase();
  const found = (meta.sheets ?? []).find(
    (s) => (s.properties?.title ?? "").trim().toLowerCase() === target,
  );
  if (!found?.properties || found.properties.sheetId == null) {
    throw new NonRetriableError(
      `Google Sheets: tab "${sheetName}" was not found in the spreadsheet`,
    );
  }
  return found.properties.sheetId;
}

type SheetsErrorBody = {
  error?: { code?: number; message?: string; status?: string };
};

/**
 * Maps a Sheets HTTP failure onto Inngest retry semantics, mirroring the Excel
 * action's `toGraphError`: 429 honors Retry-After; 400/401/403/404 are config /
 * permission problems (no retry); everything else (transient 5xx) retries.
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
