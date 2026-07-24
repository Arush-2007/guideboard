import { createHash } from "node:crypto";

export type SheetsTriggerOn = "added" | "updated" | "added_or_updated";

export type SheetsChange = {
  /** 1-based sheet row number. */
  rowIndex: number;
  changeType: "added" | "updated";
  /**
   * 0-based indices of the columns whose value changed since the previous poll.
   * Only meaningful for `"updated"`; always empty for `"added"` (a new row has no
   * prior value to diff against). The poll maps these to header NAMES for the
   * `googleSheets.changedFields` output.
   */
  changedColumns: number[];
};

/**
 * Fingerprint of a row's contents, used to spot edits between polls without
 * storing the full row. Google omits trailing empty cells, so the same visible
 * content always serializes identically across reads.
 *
 * When `columns` (0-based indices) is given, only those cells are fingerprinted,
 * so an edit to any other column leaves the hash unchanged and fires nothing —
 * this is how column-scoped edit detection works. Undefined means the whole row.
 *
 * Still used for the append idempotency key; edit detection now fingerprints each
 * cell separately (`hashCells`) so a poll can report WHICH columns changed.
 */
export function hashRow(row: string[], columns?: number[]): string {
  const cells = columns ? columns.map((i) => row[i] ?? "") : row;
  return createHash("sha1").update(JSON.stringify(cells)).digest("hex");
}

/**
 * Per-CELL fingerprints of a row, one hash per watched cell in watched order —
 * the finer-grained snapshot that lets a poll diff cell-by-cell and report which
 * columns changed, not just that the row changed.
 *
 * With `columns` (0-based indices) the array is `columns.length` long, entry `k`
 * hashing `row[columns[k]]`; undefined hashes every present cell in place (Google
 * trims trailing empties, so this stays width-stable across reads). A row counts
 * as edited iff any of these hashes differs from the previous poll's.
 */
export function hashCells(row: string[], columns?: number[]): string[] {
  const cells = columns ? columns.map((i) => row[i] ?? "") : row;
  return cells.map((c) => createHash("sha1").update(c).digest("hex"));
}

/**
 * Diffs two cell-hash arrays (same watched projection) into the 0-based column
 * indices that changed. `watchColumns` maps a scoped position `k` back to its real
 * column index; undefined means position IS the column index. Length differences
 * (a trailing cell newly filled or cleared under whole-row watching) count as a
 * change at that position.
 */
function diffCellHashes(
  oldCells: string[],
  newCells: string[],
  watchColumns?: number[],
): number[] {
  const len = Math.max(oldCells.length, newCells.length);
  const changed: number[] = [];
  for (let k = 0; k < len; k++) {
    if (oldCells[k] !== newCells[k]) {
      changed.push(watchColumns ? (watchColumns[k] ?? k) : k);
    }
  }
  return changed;
}

/**
 * Maps changed column indices to their header NAMES for the trigger's
 * `changedFields` output. A blank or missing header falls back to `Column N`
 * (1-based) so a watched but unlabeled column is still named rather than dropped.
 */
export function changedFieldNames(
  headerRow: string[],
  changedColumns: number[],
): string[] {
  return changedColumns.map((idx) => {
    const name = (headerRow[idx] ?? "").trim();
    return name || `Column ${idx + 1}`;
  });
}

/**
 * Idempotency key for a detected change: it must dedupe a step RETRY of the same
 * poll while letting a genuinely new change through.
 *
 * Appends hash the WHOLE row (independent of edit scoping — a new row is new
 * regardless of columns) so a row index REUSED after a delete still fires: a
 * static `<sid>:<rowIndex>` key would collide with the deleted row's long-lived
 * Execution forever and silently swallow the new row. Identical re-appends dedupe.
 *
 * Edits key on the POLL INVOCATION (`pollToken`), not content, because the same
 * cell can change back to a value it held before — a content key would collide
 * with that earlier edit's still-live Execution and swallow the repeat. The token
 * is stable across retries of one poll (so a retry dedupes) but distinct across
 * polls (so a later re-edit fires); a poll only ever detects a given row's edit
 * once, so there is no in-poll duplicate to worry about.
 */
export function sheetsPollIdempotencyKey(params: {
  spreadsheetId: string;
  rowIndex: number;
  changeType: "added" | "updated";
  row: string[];
  /** Stable within one poll, distinct across polls (the poll's prior lastChecked). */
  pollToken: string;
}): string {
  const discriminator =
    params.changeType === "added" ? hashRow(params.row) : params.pollToken;
  return `google_sheets:${params.spreadsheetId}:${params.rowIndex}:${discriminator}`;
}

/**
 * Maps header NAMES to their current 0-based column indices using the sheet's
 * header row (row 1). Case- and whitespace-insensitive; names with no matching
 * header are dropped (a renamed/deleted column simply stops matching). Resolving
 * at poll time — rather than storing indices — is what lets scoping survive
 * column reordering.
 */
export function resolveColumnIndices(
  headerRow: string[],
  names: string[],
): number[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const indexByName = new Map<string, number>();
  headerRow.forEach((header, i) => {
    const key = norm(header);
    // First occurrence wins, mirroring how a human reads left-to-right.
    if (key && !indexByName.has(key)) indexByName.set(key, i);
  });

  const indices: number[] = [];
  for (const name of names) {
    const i = indexByName.get(norm(name));
    if (i !== undefined) indices.push(i);
  }
  return indices;
}

/**
 * The columns to watch for edits, given the header row and the names of the
 * columns to IGNORE (the unchecked ones in the picker).
 *
 * Returns `undefined` when nothing is ignored — the whole row is watched,
 * variable-length, so a column added later is watched automatically (returning
 * explicit all-indices would instead pad missing trailing cells and misread a
 * widened sheet as edits). An empty array means every column is ignored, so no
 * edit ever fires.
 */
export function computeWatchedColumns(
  headerRow: string[],
  ignoreNames: string[],
): number[] | undefined {
  if (ignoreNames.length === 0) return undefined;
  const ignored = new Set(resolveColumnIndices(headerRow, ignoreNames));
  return headerRow.map((_, i) => i).filter((i) => !ignored.has(i));
}

/**
 * Canonical fingerprint of the watched-column PROJECTION the stored row hashes
 * were computed under. Stored alongside the hashes so a poll can tell whether
 * that projection still holds: if it changed — because the sheet's header was
 * widened/narrowed/renamed, or the user changed which columns are watched — the
 * old hashes are no longer comparable and must be re-seeded (see
 * `planSheetsPollChanges`), rather than every row reading as a spurious edit.
 *
 * Keyed on the watched columns' NAMES (not indices), so reordering columns — the
 * data moves with them, leaving the watched values unchanged — keeps the same
 * signature and does NOT force a needless re-baseline. `"*"` is the whole-row
 * projection (nothing scoped), whose hash is naturally width-stable.
 */
export function watchColumnsSignature(
  headerRow: string[],
  watchColumns: number[] | undefined,
): string {
  if (watchColumns === undefined) return "*";
  // JSON-encode the sorted names rather than join them: an unambiguous, all-ASCII
  // representation where ["a","b"] and ["a b"] can't collide into one signature
  // (a collision would miss a header split/merge and skip the needed re-baseline).
  const names = watchColumns.map((i) =>
    (headerRow[i] ?? "").trim().toLowerCase(),
  );
  return JSON.stringify(names.sort());
}

/**
 * Zips a data row against the header row into a `{ header: value }` object, so a
 * downstream node can reference a cell by its column NAME (e.g.
 * `@<googleSheets.values.Status>@`) instead of a positional index. Header keys
 * are trimmed to match `getSheetColumns`/the dialog's picker; blank headers are
 * dropped and missing cells become "".
 */
export function rowValuesByHeader(
  headerRow: string[],
  row: string[],
): Record<string, string> {
  const values: Record<string, string> = {};
  headerRow.forEach((header, i) => {
    const key = (header ?? "").trim();
    if (key) values[key] = row[i] ?? "";
  });
  return values;
}

/**
 * The poll's stored edit snapshot: per-row, per-cell hashes + the projection they
 * cover. Cell-level (not row-level) so a poll can report which columns changed.
 */
export type SheetsPollSnapshot = { sig: string; cellHashes: string[][] };

function isCellHashes(v: unknown): v is string[][] {
  return (
    Array.isArray(v) &&
    v.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string"))
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((c) => typeof c === "string");
}

/**
 * Reads the stored snapshot back into `{ cellHashes, sig }`, the single place that
 * knows its persisted shape. Current shape is `{ sig, cellHashes }`.
 *
 * The two legacy shapes stored per-ROW hashes — `{ sig, hashes }` and, older
 * still, a bare `string[]`. Neither can be diffed at the cell level, so both are
 * lifted to a non-null placeholder (one hash per row) with `sig: null`. That
 * `null` signature forces the projection guard in `planSheetsPollChanges` to
 * suppress THIS poll's edits and re-seed real cell hashes — while the preserved
 * row COUNT still lets appends fire. Anything else reads as no snapshot: a
 * first-poll baseline.
 */
export function readSnapshot(stored: unknown): {
  cellHashes: string[][] | null;
  sig: string | null;
} {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const obj = stored as {
      cellHashes?: unknown;
      hashes?: unknown;
      sig?: unknown;
    };
    if (isCellHashes(obj.cellHashes)) {
      return {
        cellHashes: obj.cellHashes,
        sig: typeof obj.sig === "string" ? obj.sig : null,
      };
    }
    // Legacy per-row hashes: re-seed once (sig null → edits suppressed, appends fire).
    if (isStringArray(obj.hashes)) {
      return { cellHashes: obj.hashes.map((h) => [h]), sig: null };
    }
  }
  // Oldest legacy shape: a bare per-row hash array. Same one-time re-seed.
  if (isStringArray(stored)) {
    return { cellHashes: stored.map((h) => [h]), sig: null };
  }
  return { cellHashes: null, sig: null };
}

/**
 * Decides which rows to fire executions for, given the current sheet contents
 * and the snapshot from the previous poll. Pure so the (fiddly) append-vs-edit
 * logic can be unit-tested without Inngest or Google in the loop.
 *
 * Row identity is by position: row N this poll is compared against row N last
 * poll. That fits sheets that grow at the bottom (form responses, logs); a row
 * inserted or deleted in the middle shifts everything below and reads as a run
 * of edits.
 *
 * Row 1 is always the header: edits to it never fire "updated", since renaming
 * a column is a schema tweak, not a data event.
 *
 * The first poll (no prior snapshot — `oldHashes` is null) is a baseline: it
 * records the current sheet and fires nothing. Attaching the trigger must not
 * backfill every pre-existing row, so only rows added or edited AFTER setup
 * trigger the workflow — which also means the header can never fire on setup.
 *
 * `watchColumns` (0-based indices) scopes edit detection to specific columns, so
 * a change outside them fires nothing. Undefined watches the whole row. Appends
 * are unaffected — a new row fires regardless of which columns it fills.
 *
 * `oldSignature`/`newSignature` (from `watchColumnsSignature`) guard against
 * comparing hashes across a changed projection: when they differ, the stored
 * hashes describe a DIFFERENT set of watched columns, so an edit diff would be
 * garbage (every row would look changed). In that case edits are suppressed and
 * the hashes re-seed — but appends still fire, since a new row is an append no
 * matter which columns are watched. This is what makes adding a column to a
 * scoped sheet, or changing the watched set, re-baseline cleanly instead of
 * firing a false edit storm.
 */
export function planSheetsPollChanges(params: {
  rows: string[][];
  /** Row count at the previous poll; positions at or beyond this are appends. */
  lastRowCount: number;
  /** Per-position, per-cell hashes from the previous poll; null before the first. */
  oldCellHashes: string[][] | null;
  triggerOn: SheetsTriggerOn;
  /** 0-based column indices to scope edit detection to; undefined = whole row. */
  watchColumns?: number[];
  /** Projection signature the stored hashes were computed under; null if unknown. */
  oldSignature?: string | null;
  /** Projection signature for this poll; null skips the check (e.g. in tests). */
  newSignature?: string | null;
}): { changes: SheetsChange[]; newCellHashes: string[][] } {
  const {
    rows,
    lastRowCount,
    oldCellHashes,
    triggerOn,
    watchColumns,
    oldSignature = null,
    newSignature = null,
  } = params;
  const newCellHashes = rows.map((row) => hashCells(row, watchColumns));

  // First poll for this trigger: capture the current sheet as the baseline and
  // fire nothing. A fresh trigger must not backfill pre-existing rows (and so
  // can't fire for the header either).
  if (oldCellHashes === null) {
    return { changes: [], newCellHashes };
  }

  // The stored hashes were computed under a different watched-column projection
  // (header change or a changed watched set), so a per-position edit diff would
  // be meaningless. Re-seed by suppressing edits this poll; appends still fire.
  const staleSnapshot = newSignature !== null && oldSignature !== newSignature;

  const watchAdded = triggerOn === "added" || triggerOn === "added_or_updated";
  const watchUpdated =
    triggerOn === "updated" || triggerOn === "added_or_updated";

  const changes: SheetsChange[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowIndex = i + 1;

    if (i >= lastRowCount) {
      // Row beyond the previous count — an append.
      if (watchAdded)
        changes.push({ rowIndex, changeType: "added", changedColumns: [] });
      continue;
    }

    // Existing position: an edit only if the content at this position actually
    // changed AND the snapshot is comparable. Row 1 (i === 0) is the header, so
    // its edits are ignored.
    if (!staleSnapshot && watchUpdated && i > 0 && i < oldCellHashes.length) {
      const changedColumns = diffCellHashes(
        oldCellHashes[i],
        newCellHashes[i],
        watchColumns,
      );
      if (changedColumns.length > 0) {
        changes.push({ rowIndex, changeType: "updated", changedColumns });
      }
    }
  }

  return { changes, newCellHashes };
}
