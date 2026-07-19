import { createHash } from "node:crypto";

export type SheetsTriggerOn = "added" | "updated" | "added_or_updated";

export type SheetsChange = {
  /** 1-based sheet row number. */
  rowIndex: number;
  changeType: "added" | "updated";
};

/**
 * Fingerprint of a row's contents, used to spot edits between polls without
 * storing the full row. Google omits trailing empty cells, so the same visible
 * content always serializes identically across reads.
 *
 * When `columns` (0-based indices) is given, only those cells are fingerprinted,
 * so an edit to any other column leaves the hash unchanged and fires nothing —
 * this is how column-scoped edit detection works. Undefined means the whole row.
 */
export function hashRow(row: string[], columns?: number[]): string {
  const cells = columns ? columns.map((i) => row[i] ?? "") : row;
  return createHash("sha1").update(JSON.stringify(cells)).digest("hex");
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

/** The poll's stored edit snapshot: per-row hashes + the projection they cover. */
export type SheetsPollSnapshot = { sig: string; hashes: string[] };

/**
 * Reads the stored snapshot back into `{ hashes, sig }`, the single place that
 * knows its persisted shape. The current shape is `{ sig, hashes }`; a bare array
 * is the legacy pre-signature shape (read with an unknown signature, so the next
 * poll re-seeds once); anything else reads as no snapshot — a first-poll baseline.
 */
export function readSnapshot(stored: unknown): {
  hashes: string[] | null;
  sig: string | null;
} {
  if (Array.isArray(stored)) return { hashes: stored as string[], sig: null };
  if (stored && typeof stored === "object") {
    const obj = stored as { hashes?: unknown; sig?: unknown };
    if (Array.isArray(obj.hashes)) {
      return {
        hashes: obj.hashes as string[],
        sig: typeof obj.sig === "string" ? obj.sig : null,
      };
    }
  }
  return { hashes: null, sig: null };
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
  /** Per-position hashes from the previous poll, or null before the first one. */
  oldHashes: string[] | null;
  triggerOn: SheetsTriggerOn;
  /** 0-based column indices to scope edit detection to; undefined = whole row. */
  watchColumns?: number[];
  /** Projection signature the stored hashes were computed under; null if unknown. */
  oldSignature?: string | null;
  /** Projection signature for this poll; null skips the check (e.g. in tests). */
  newSignature?: string | null;
}): { changes: SheetsChange[]; newHashes: string[] } {
  const {
    rows,
    lastRowCount,
    oldHashes,
    triggerOn,
    watchColumns,
    oldSignature = null,
    newSignature = null,
  } = params;
  const newHashes = rows.map((row) => hashRow(row, watchColumns));

  // First poll for this trigger: capture the current sheet as the baseline and
  // fire nothing. A fresh trigger must not backfill pre-existing rows (and so
  // can't fire for the header either).
  if (oldHashes === null) {
    return { changes: [], newHashes };
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
      if (watchAdded) changes.push({ rowIndex, changeType: "added" });
      continue;
    }

    // Existing position: an edit only if the content at this position actually
    // changed AND the snapshot is comparable. Row 1 (i === 0) is the header, so
    // its edits are ignored.
    if (
      !staleSnapshot &&
      watchUpdated &&
      i > 0 &&
      i < oldHashes.length &&
      oldHashes[i] !== newHashes[i]
    ) {
      changes.push({ rowIndex, changeType: "updated" });
    }
  }

  return { changes, newHashes };
}
