import { describe, expect, it } from "vitest";
import { hashRow, planSheetsPollChanges } from "./sheets-poll-diff";

const hashes = (rows: string[][]) => rows.map(hashRow);

describe("planSheetsPollChanges", () => {
  it("fires an added change for each appended row", () => {
    const rows = [["h1"], ["a"], ["b"], ["c"]];
    const { changes } = planSheetsPollChanges({
      rows,
      lastRowCount: 2, // header + one existing row
      oldHashes: hashes(rows.slice(0, 2)),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([
      { rowIndex: 3, changeType: "added" },
      { rowIndex: 4, changeType: "added" },
    ]);
  });

  it("fires an updated change when an existing row's content changes", () => {
    const before = [["h1"], ["a"], ["b"]];
    const after = [["h1"], ["a"], ["b-edited"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldHashes: hashes(before),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([{ rowIndex: 3, changeType: "updated" }]);
  });

  it("fires nothing when re-polling an unchanged sheet", () => {
    const rows = [["h1"], ["a"], ["b"]];
    const { changes } = planSheetsPollChanges({
      rows,
      lastRowCount: rows.length,
      oldHashes: hashes(rows),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([]);
  });

  it("reports no edits on the first poll (null snapshot), only appends", () => {
    const rows = [["h1"], ["a"], ["b"]];
    const { changes, newHashes } = planSheetsPollChanges({
      rows,
      lastRowCount: rows.length, // count already seeded, so no appends either
      oldHashes: null,
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([]);
    expect(newHashes).toEqual(hashes(rows));
  });

  it("added mode ignores edits", () => {
    const before = [["h1"], ["a"]];
    const after = [["h1"], ["a-edited"], ["new"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldHashes: hashes(before),
      triggerOn: "added",
    });

    expect(changes).toEqual([{ rowIndex: 3, changeType: "added" }]);
  });

  it("updated mode ignores appends", () => {
    const before = [["h1"], ["a"]];
    const after = [["h1"], ["a-edited"], ["new"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldHashes: hashes(before),
      triggerOn: "updated",
    });

    expect(changes).toEqual([{ rowIndex: 2, changeType: "updated" }]);
  });

  it("detects both an append and an edit in one poll", () => {
    const before = [["h1"], ["a"], ["b"]];
    const after = [["h1"], ["a"], ["b-edited"], ["c"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldHashes: hashes(before),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([
      { rowIndex: 3, changeType: "updated" },
      { rowIndex: 4, changeType: "added" },
    ]);
  });

  it("does not report shrunk rows as changes and returns the trimmed hashes", () => {
    const before = [["h1"], ["a"], ["b"], ["c"]];
    const after = [["h1"], ["a"]]; // two rows deleted from the end
    const { changes, newHashes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldHashes: hashes(before),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([]);
    expect(newHashes).toHaveLength(2);
  });
});
