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
 */
export function hashRow(row: string[]): string {
  return createHash("sha1").update(JSON.stringify(row)).digest("hex");
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
 */
export function planSheetsPollChanges(params: {
  rows: string[][];
  /** Row count at the previous poll; positions at or beyond this are appends. */
  lastRowCount: number;
  /** Per-position hashes from the previous poll, or null before the first one. */
  oldHashes: string[] | null;
  triggerOn: SheetsTriggerOn;
}): { changes: SheetsChange[]; newHashes: string[] } {
  const { rows, lastRowCount, oldHashes, triggerOn } = params;
  const newHashes = rows.map(hashRow);

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

    // Existing position: an edit only if we have a prior snapshot and the
    // content at this position actually changed. Without a snapshot (first poll
    // after enabling edit detection) nothing is reported as edited.
    if (
      watchUpdated &&
      oldHashes &&
      i < oldHashes.length &&
      oldHashes[i] !== newHashes[i]
    ) {
      changes.push({ rowIndex, changeType: "updated" });
    }
  }

  return { changes, newHashes };
}
