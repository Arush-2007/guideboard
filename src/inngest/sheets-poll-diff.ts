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
 * hashing `row[columns[k]]`; undefined hashes every present cell in place, which
 * is RAGGED — Google trims trailing empty cells, so the same row varies in width
 * as its last columns fill and clear. `diffCellHashes` is what reconciles that,
 * treating an absent position as empty. A row counts as edited iff any hash
 * differs from the previous poll's under that comparison.
 */
export function hashCells(row: string[], columns?: number[]): string[] {
  const cells = columns ? columns.map((i) => row[i] ?? "") : row;
  return cells.map((c) => createHash("sha1").update(c).digest("hex"));
}

/** `hashCells`' value for an empty cell — what an ABSENT trailing cell means. */
const EMPTY_CELL_HASH = createHash("sha1").update("").digest("hex");

/**
 * Diffs two cell-hash arrays (same watched projection) into the 0-based column
 * indices that changed. `watchColumns` maps a scoped position `k` back to its real
 * column index; undefined means position IS the column index.
 *
 * A position missing from either side reads as EMPTY, not as a change. Under
 * whole-row watching the two sides are ragged — Google trims trailing empty
 * cells, so a row stored as `["Ada","Acme"]` comes back six cells wide the moment
 * column F is filled. Comparing raw `undefined` against `hash("")` then marked
 * every position in between as changed, and the trigger reported
 * `changedFields = "C, D, E, F"` for a single edit to F — breaking any workflow
 * that branches on WHICH field changed. Normalizing absent to empty compares the
 * two rows by their visible content, which is what raggedness encodes.
 *
 * Done here rather than by padding the stored hashes to the header width: the
 * whole-row projection signature is `"*"` regardless of width, so widening the
 * snapshot format would NOT invalidate existing rows, and the first poll after
 * deploy would diff every ragged stored row against a padded new one — the exact
 * false-edit storm this fixes. Normalizing at compare time reads old and new
 * snapshots identically and needs no re-baseline.
 */
function diffCellHashes(
  oldCells: string[],
  newCells: string[],
  watchColumns?: number[],
): number[] {
  const len = Math.max(oldCells.length, newCells.length);
  const changed: number[] = [];
  for (let k = 0; k < len; k++) {
    const before = oldCells[k] ?? EMPTY_CELL_HASH;
    const after = newCells[k] ?? EMPTY_CELL_HASH;
    if (before !== after) {
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

/** How a header name is compared everywhere: case- and whitespace-insensitive. */
const norm = (s: string) => s.trim().toLowerCase();

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
 * Detects columns RENAMED IN PLACE between two header rows, as a map of
 * `oldIndex -> new name`.
 *
 * A rename is only claimed when the old name is gone from the new header AND the
 * new header holds an unclaimed, non-blank name at the SAME index. That
 * same-index requirement is the discriminator: the values API gives us labels
 * only, so "renamed B to X" and "deleted B, added X" are otherwise identical
 * before/after states. Renaming leaves the column where it is, while a delete
 * shifts its neighbours, so demanding a positional match claims the common case
 * and declines the ambiguous one — and declining just means no heal, which is
 * where this started.
 *
 * Names surviving anywhere in the new header are matched first (and their new
 * slots claimed), so a pure REORDER produces no renames at all.
 */
export function detectRenamedColumns(
  oldHeader: string[],
  newHeader: string[],
): Map<number, string> {
  const survivingNames = new Set(newHeader.map(norm).filter(Boolean));
  // A slot is claimed when some old column still carries that name — a moved
  // column, not a rename target.
  const claimed = new Set(
    resolveColumnIndices(
      newHeader,
      oldHeader.filter((name) => survivingNames.has(norm(name))),
    ),
  );

  const renames = new Map<number, string>();
  oldHeader.forEach((oldName, i) => {
    if (!norm(oldName) || survivingNames.has(norm(oldName))) return;
    const newName = newHeader[i];
    if (!newName || !norm(newName) || claimed.has(i)) return;
    renames.set(i, newName);
  });
  return renames;
}

/**
 * Follows a renamed header through the user's IGNORE list, returning the updated
 * names — or `null` when nothing moved, so the caller can skip the write.
 *
 * The ignore list is stored as header names and re-resolved against the live
 * header each poll (that's what lets scoping survive a reorder). The flip side is
 * that renaming an ignored column made its stored name stop matching, so the
 * column silently became WATCHED — scoping the user configured was quietly lost,
 * and the widened watched set also tripped the projection guard, suppressing that
 * poll's edits. Rewriting the stored name to follow the rename keeps the setting
 * pointed at the column the user picked.
 *
 * Only names that no longer resolve are touched, so a rename that merely
 * reorders, or one affecting an unrelated column, is a no-op. A name that
 * resolves in neither header is left alone for the dialog to show as "not found".
 */
export function healIgnoreColumns(
  ignoreNames: string[],
  oldHeader: string[],
  newHeader: string[],
): string[] | null {
  if (ignoreNames.length === 0 || oldHeader.length === 0) return null;

  const renames = detectRenamedColumns(oldHeader, newHeader);
  if (renames.size === 0) return null;

  let changed = false;
  const healed = ignoreNames.map((name) => {
    if (resolveColumnIndices(newHeader, [name]).length > 0) return name;
    const oldIndex = resolveColumnIndices(oldHeader, [name])[0];
    const renamedTo =
      oldIndex === undefined ? undefined : renames.get(oldIndex);
    if (renamedTo === undefined) return name;
    changed = true;
    return renamedTo;
  });

  return changed ? healed : null;
}

/**
 * Canonical fingerprint of the watched columns' NAMES. Stable across a column
 * REORDER — the data moves with the header, so the watched values are unchanged
 * — which is the identity that survives reordering. `"*"` is the whole-row
 * projection (nothing scoped), whose hash is naturally width-stable.
 */
function watchColumnsNameSignature(
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
 * The watched-column PROJECTION the stored per-position cell hashes were computed
 * under — i.e. which column each stored position describes. Persisted alongside
 * the hashes so a poll can tell whether that projection still holds: if it no
 * longer does, the old hashes aren't comparable and must be re-seeded (see
 * `planSheetsPollChanges`) rather than every row reading as a spurious edit.
 *
 * Recorded under TWO independent identities because neither survives every edit a
 * user makes to a header row on its own; `projectionsComparable` accepts either.
 */
export type SheetsProjection = {
  /** Watched column NAMES. Survives a reorder; changes on a rename. */
  names: string;
  /** Watched column INDICES. Survives a rename; changes on a reorder. */
  cols: string;
};

/**
 * A projection recovered from a stored snapshot, where the index identity may
 * predate the field — that's the one asymmetry with a freshly computed one.
 */
export type StoredProjection = Omit<SheetsProjection, "cols"> & {
  cols: string | null;
};

export function sheetsProjection(
  headerRow: string[],
  watchColumns: number[] | undefined,
): SheetsProjection {
  return {
    names: watchColumnsNameSignature(headerRow, watchColumns),
    // Whole-row watching is width-agnostic, so it has no index list to pin.
    cols: watchColumns === undefined ? "*" : JSON.stringify(watchColumns),
  };
}

/**
 * Whether the stored per-position cell hashes can still be diffed against this
 * poll's — whether both sides' positions describe the same columns.
 *
 * EITHER identity matching is enough, because each covers what the other misses:
 * - **Names** match → a REORDER. Indices moved, but the data moved with the
 *   header, so position `k` still holds the same column's value.
 * - **Indices** match → a RENAME. The label changed; the column at each watched
 *   position, and its data, did not.
 *
 * Requiring names alone (as this once did) meant renaming one header re-baselined
 * the whole sheet, silently swallowing every genuine row edit made in the same
 * poll window. The indices are untouched by a rename, so they keep the snapshot
 * comparable and those edits fire.
 *
 * A rename that also changes the watched SET still re-baselines, correctly: an
 * IGNORED column that gets renamed stops matching the ignore list and becomes
 * watched, which shifts the indices too, so neither identity matches and the
 * positions really do describe new columns.
 *
 * A null stored projection means "unknown" — a legacy snapshot, or one written
 * without a signature — and is never comparable, forcing the re-seed.
 */
export function projectionsComparable(
  stored: StoredProjection | null,
  current: SheetsProjection,
): boolean {
  if (stored === null) return false;
  if (stored.names === current.names) return true;
  return stored.cols !== null && stored.cols === current.cols;
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
export type SheetsPollSnapshot = {
  /** The projection's NAME signature. Keyed `sig` because that's the historical
   *  key — snapshots written before `cols` existed still read back correctly. */
  sig: string;
  /** The projection's INDEX signature. Absent in pre-`cols` snapshots. */
  cols: string;
  /** Row 1 as last seen, so the next poll can spot a renamed column by diffing
   *  it against the live header. Absent in snapshots written before this. */
  header: string[];
  cellHashes: string[][];
};

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
 * Reads the stored snapshot back into `{ cellHashes, projection, header }`, the
 * single place that knows its persisted shape. Current shape is
 * `{ sig, cols, header, cellHashes }`.
 *
 * A snapshot written before `cols` existed still yields a usable projection —
 * names only, `cols: null` — so deploying the index identity costs no re-baseline;
 * those polls keep comparing by name until the next write records both. A missing
 * `header` likewise just means no rename healing until the next write records one.
 *
 * The two legacy shapes stored per-ROW hashes — `{ sig, hashes }` and, older
 * still, a bare `string[]`. Neither can be diffed at the cell level, so both are
 * lifted to a non-null placeholder (one hash per row) with a `null` projection.
 * That forces the projection guard in `planSheetsPollChanges` to suppress THIS
 * poll's edits and re-seed real cell hashes — while the preserved row COUNT still
 * lets appends fire. Anything else reads as no snapshot: a first-poll baseline.
 */
export function readSnapshot(stored: unknown): {
  cellHashes: string[][] | null;
  projection: StoredProjection | null;
  header: string[] | null;
} {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const obj = stored as {
      cellHashes?: unknown;
      hashes?: unknown;
      sig?: unknown;
      cols?: unknown;
      header?: unknown;
    };
    if (isCellHashes(obj.cellHashes)) {
      return {
        cellHashes: obj.cellHashes,
        projection:
          typeof obj.sig === "string"
            ? {
                names: obj.sig,
                cols: typeof obj.cols === "string" ? obj.cols : null,
              }
            : null,
        header: isStringArray(obj.header) ? obj.header : null,
      };
    }
    // Legacy per-row hashes: re-seed once (no projection → edits suppressed,
    // appends fire).
    if (isStringArray(obj.hashes)) {
      return {
        cellHashes: obj.hashes.map((h) => [h]),
        projection: null,
        header: null,
      };
    }
  }
  // Oldest legacy shape: a bare per-row hash array. Same one-time re-seed.
  if (isStringArray(stored)) {
    return {
      cellHashes: stored.map((h) => [h]),
      projection: null,
      header: null,
    };
  }
  return { cellHashes: null, projection: null, header: null };
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
 * Row 1 is always the header, never a data row, so it fires NEITHER kind of
 * change: not "updated", since renaming a column is a schema tweak rather than a
 * data event, and not "added" either. The append case only shows up on a sheet
 * that was empty at the baseline poll — typing its header row then grew the row
 * count from 0 to 1 and fired row 1 as a new record, whose `values` were the
 * header mapped onto itself (`{ Name: "Name" }`). The first real data row lands
 * at row 2 and fires normally.
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
 * `oldProjection`/`newProjection` (from `sheetsProjection`) guard against
 * comparing hashes across a changed projection: when they aren't comparable, the
 * stored hashes describe a DIFFERENT set of watched columns, so an edit diff
 * would be garbage (every row would look changed). In that case edits are
 * suppressed and the hashes re-seed — but appends still fire, since a new row is
 * an append no matter which columns are watched. This is what makes adding a
 * column to a scoped sheet, or changing the watched set, re-baseline cleanly
 * instead of firing a false edit storm. Renaming or reordering a header does NOT
 * trip it — see `projectionsComparable`.
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
  /** Projection the stored hashes were computed under; null if unknown. */
  oldProjection?: StoredProjection | null;
  /** Projection for this poll; null skips the check (e.g. in tests). */
  newProjection?: SheetsProjection | null;
}): { changes: SheetsChange[]; newCellHashes: string[][] } {
  const {
    rows,
    lastRowCount,
    oldCellHashes,
    triggerOn,
    watchColumns,
    oldProjection = null,
    newProjection = null,
  } = params;
  const newCellHashes = rows.map((row) => hashCells(row, watchColumns));

  // First poll for this trigger: capture the current sheet as the baseline and
  // fire nothing. A fresh trigger must not backfill pre-existing rows (and so
  // can't fire for the header either).
  if (oldCellHashes === null) {
    return { changes: [], newCellHashes };
  }

  // The stored hashes were computed under a watched-column projection this poll's
  // positions no longer match (a column added/removed, or a changed watched set),
  // so a per-position edit diff would be meaningless. Re-seed by suppressing edits
  // this poll; appends still fire.
  const staleSnapshot =
    newProjection !== null &&
    !projectionsComparable(oldProjection, newProjection);

  const watchAdded = triggerOn === "added" || triggerOn === "added_or_updated";
  const watchUpdated =
    triggerOn === "updated" || triggerOn === "added_or_updated";

  const changes: SheetsChange[] = [];

  // From i = 1: position 0 is the header row, which is never a data row and so
  // can't be added or edited. Skipping it structurally (rather than per branch)
  // is what keeps a sheet that was empty at the baseline from firing its header
  // as an appended record once someone types it.
  for (let i = 1; i < rows.length; i++) {
    const rowIndex = i + 1;

    if (i >= lastRowCount) {
      // Row beyond the previous count — an append.
      if (watchAdded)
        changes.push({ rowIndex, changeType: "added", changedColumns: [] });
      continue;
    }

    // Existing position: an edit only if the content at this position actually
    // changed AND the snapshot is comparable.
    if (!staleSnapshot && watchUpdated && i < oldCellHashes.length) {
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
