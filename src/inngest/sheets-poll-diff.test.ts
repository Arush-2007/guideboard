import { describe, expect, it } from "vitest";
import {
  changedFieldNames,
  computeWatchedColumns,
  detectRenamedColumns,
  hashCells,
  healIgnoreColumns,
  planSheetsPollChanges,
  projectionsComparable,
  readSnapshot,
  resolveColumnIndices,
  rowValuesByHeader,
  sheetsPollIdempotencyKey,
  sheetsProjection,
} from "./sheets-poll-diff";

const cells = (rows: string[][], columns?: number[]) =>
  rows.map((row) => hashCells(row, columns));

describe("planSheetsPollChanges", () => {
  it("fires an added change for each appended row", () => {
    const rows = [["h1"], ["a"], ["b"], ["c"]];
    const { changes } = planSheetsPollChanges({
      rows,
      lastRowCount: 2, // header + one existing row
      oldCellHashes: cells(rows.slice(0, 2)),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([
      { rowIndex: 3, changeType: "added", changedColumns: [] },
      { rowIndex: 4, changeType: "added", changedColumns: [] },
    ]);
  });

  it("fires an updated change when an existing row's content changes", () => {
    const before = [["h1"], ["a"], ["b"]];
    const after = [["h1"], ["a"], ["b-edited"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldCellHashes: cells(before),
      triggerOn: "added_or_updated",
    });

    // Whole-row watch: the single (index-0) cell changed.
    expect(changes).toEqual([
      { rowIndex: 3, changeType: "updated", changedColumns: [0] },
    ]);
  });

  it("fires nothing when re-polling an unchanged sheet", () => {
    const rows = [["h1"], ["a"], ["b"]];
    const { changes } = planSheetsPollChanges({
      rows,
      lastRowCount: rows.length,
      oldCellHashes: cells(rows),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([]);
  });

  it("first poll (null snapshot) is a baseline: fires nothing, backfills no pre-existing rows", () => {
    const rows = [["h1"], ["a"], ["b"]];
    const { changes, newCellHashes } = planSheetsPollChanges({
      rows,
      // A brand-new poll — lastRowCount defaults to 0 — but existing rows must
      // NOT be backfilled as appends; the first poll only seeds the baseline.
      lastRowCount: 0,
      oldCellHashes: null,
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([]);
    expect(newCellHashes).toEqual(cells(rows));
  });

  it("fires appends only for rows added after the baseline poll", () => {
    const baseline = [["h1"], ["a"], ["b"]];
    // Second poll, one row appended since the baseline was captured.
    const after = [["h1"], ["a"], ["b"], ["c"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: baseline.length,
      oldCellHashes: cells(baseline),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([
      { rowIndex: 4, changeType: "added", changedColumns: [] },
    ]);
  });

  it("added mode ignores edits", () => {
    const before = [["h1"], ["a"]];
    const after = [["h1"], ["a-edited"], ["new"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldCellHashes: cells(before),
      triggerOn: "added",
    });

    expect(changes).toEqual([
      { rowIndex: 3, changeType: "added", changedColumns: [] },
    ]);
  });

  it("updated mode ignores appends", () => {
    const before = [["h1"], ["a"]];
    const after = [["h1"], ["a-edited"], ["new"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldCellHashes: cells(before),
      triggerOn: "updated",
    });

    expect(changes).toEqual([
      { rowIndex: 2, changeType: "updated", changedColumns: [0] },
    ]);
  });

  it("detects both an append and an edit in one poll", () => {
    const before = [["h1"], ["a"], ["b"]];
    const after = [["h1"], ["a"], ["b-edited"], ["c"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldCellHashes: cells(before),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([
      { rowIndex: 3, changeType: "updated", changedColumns: [0] },
      { rowIndex: 4, changeType: "added", changedColumns: [] },
    ]);
  });

  it("ignores edits to the header row (row 1)", () => {
    const before = [["Name"], ["a"], ["b"]];
    const after = [["Full Name"], ["a"], ["b-edited"]];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldCellHashes: cells(before),
      triggerOn: "added_or_updated",
    });

    // Header change dropped; the row-3 edit still fires.
    expect(changes).toEqual([
      { rowIndex: 3, changeType: "updated", changedColumns: [0] },
    ]);
  });

  // The header is a schema row, not a record. On a sheet that was empty when the
  // trigger baselined, typing it grew the row count 0 → 1 and fired row 1 as an
  // appended record whose `values` were the header mapped onto itself.
  describe("a sheet that was empty at the baseline poll", () => {
    it("does not fire when the header row is typed", () => {
      const { changes } = planSheetsPollChanges({
        rows: [["Name", "Status"]],
        lastRowCount: 0,
        oldCellHashes: [], // baselined empty — a snapshot, not a first poll
        triggerOn: "added_or_updated",
      });

      expect(changes).toEqual([]);
    });

    it("fires the first real data row, at row 2", () => {
      const { changes } = planSheetsPollChanges({
        rows: [
          ["Name", "Status"],
          ["Ada", "new"],
        ],
        lastRowCount: 1, // the header was recorded by the previous poll
        oldCellHashes: cells([["Name", "Status"]]),
        triggerOn: "added_or_updated",
      });

      expect(changes).toEqual([
        { rowIndex: 2, changeType: "added", changedColumns: [] },
      ]);
    });

    it("fires only the data row when header and first row appear together", () => {
      const { changes } = planSheetsPollChanges({
        rows: [
          ["Name", "Status"],
          ["Ada", "new"],
        ],
        lastRowCount: 0,
        oldCellHashes: [],
        triggerOn: "added_or_updated",
      });

      expect(changes).toEqual([
        { rowIndex: 2, changeType: "added", changedColumns: [] },
      ]);
    });
  });

  it("does not report shrunk rows as changes and returns the trimmed hashes", () => {
    const before = [["h1"], ["a"], ["b"], ["c"]];
    const after = [["h1"], ["a"]]; // two rows deleted from the end
    const { changes, newCellHashes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldCellHashes: cells(before),
      triggerOn: "added_or_updated",
    });

    expect(changes).toEqual([]);
    expect(newCellHashes).toHaveLength(2);
  });

  // Regression: Google trims trailing empty cells, so a stored row is narrower
  // than the same row once a later column is filled. Diffing the ragged arrays
  // raw compared `undefined` against `hash("")` and reported every position in
  // between as changed — one edit to F came back as `changedFields = "C, D, E,
  // F"`, so branching on WHICH field changed was wrong.
  describe("ragged rows (trailing empty cells)", () => {
    const header = ["A", "B", "C", "D", "E", "F"];

    it("reports only the filled column, not the gap before it", () => {
      const before = [header, ["Ada", "Acme"]];
      const after = [header, ["Ada", "Acme", "", "", "", "X"]];
      const { changes } = planSheetsPollChanges({
        rows: after,
        lastRowCount: before.length,
        oldCellHashes: cells(before),
        triggerOn: "added_or_updated",
      });

      expect(changes).toEqual([
        { rowIndex: 2, changeType: "updated", changedColumns: [5] },
      ]);
      expect(changedFieldNames(header, changes[0].changedColumns)).toEqual([
        "F",
      ]);
    });

    it("reports only the cleared column when a trailing cell empties", () => {
      const before = [header, ["Ada", "Acme", "", "", "", "X"]];
      const after = [header, ["Ada", "Acme"]];
      const { changes } = planSheetsPollChanges({
        rows: after,
        lastRowCount: before.length,
        oldCellHashes: cells(before),
        triggerOn: "added_or_updated",
      });

      expect(changes).toEqual([
        { rowIndex: 2, changeType: "updated", changedColumns: [5] },
      ]);
    });

    it("fires nothing when only the trailing padding differs", () => {
      const before = [header, ["Ada", "Acme"]];
      const after = [header, ["Ada", "Acme", "", "", ""]];
      const { changes } = planSheetsPollChanges({
        rows: after,
        lastRowCount: before.length,
        oldCellHashes: cells(before),
        triggerOn: "added_or_updated",
      });

      expect(changes).toEqual([]);
    });
  });

  describe("watchColumns (column-scoped edits)", () => {
    // Columns: 0=Name, 1=City, 2=Status. Watch only Status (index 2).
    const before = [
      ["Name", "City", "Status"],
      ["Aarav", "Pune", "Pending"],
    ];

    it("fires when a watched column changes", () => {
      const after = [
        ["Name", "City", "Status"],
        ["Aarav", "Pune", "Done"],
      ];
      const { changes } = planSheetsPollChanges({
        rows: after,
        lastRowCount: before.length,
        oldCellHashes: cells(before, [2]),
        triggerOn: "added_or_updated",
        watchColumns: [2],
      });

      // Position 0 of the [2] projection maps back to real column index 2.
      expect(changes).toEqual([
        { rowIndex: 2, changeType: "updated", changedColumns: [2] },
      ]);
    });

    it("ignores edits to unwatched columns", () => {
      const after = [
        ["Name", "City", "Status"],
        ["Aarav", "Mumbai", "Pending"], // City changed, Status did not
      ];
      const { changes } = planSheetsPollChanges({
        rows: after,
        lastRowCount: before.length,
        oldCellHashes: cells(before, [2]),
        triggerOn: "added_or_updated",
        watchColumns: [2],
      });

      expect(changes).toEqual([]);
    });

    it("still fires appends regardless of watched columns", () => {
      const after = [
        ["Name", "City", "Status"],
        ["Aarav", "Pune", "Pending"],
        ["Bhavna", "Delhi", "New"],
      ];
      const { changes } = planSheetsPollChanges({
        rows: after,
        lastRowCount: before.length,
        oldCellHashes: cells(before, [2]),
        triggerOn: "added_or_updated",
        watchColumns: [2],
      });

      expect(changes).toEqual([
        { rowIndex: 3, changeType: "added", changedColumns: [] },
      ]);
    });

    it("fires when any of several watched columns changes", () => {
      const after = [
        ["Name", "City", "Status"],
        ["Aarav", "Nagpur", "Pending"], // City (watched) changed
      ];
      const { changes } = planSheetsPollChanges({
        rows: after,
        lastRowCount: before.length,
        oldCellHashes: cells(before, [1, 2]),
        triggerOn: "added_or_updated",
        watchColumns: [1, 2],
      });

      // City is position 0 of the [1,2] projection → real column index 1.
      expect(changes).toEqual([
        { rowIndex: 2, changeType: "updated", changedColumns: [1] },
      ]);
    });

    it("reports every changed watched column when several change at once", () => {
      const after = [
        ["Name", "City", "Status"],
        ["Aarav", "Nagpur", "Done"], // both City (1) and Status (2) changed
      ];
      const { changes } = planSheetsPollChanges({
        rows: after,
        lastRowCount: before.length,
        oldCellHashes: cells(before, [1, 2]),
        triggerOn: "added_or_updated",
        watchColumns: [1, 2],
      });

      expect(changes).toEqual([
        { rowIndex: 2, changeType: "updated", changedColumns: [1, 2] },
      ]);
    });
  });
});

describe("resolveColumnIndices", () => {
  const headers = ["Name", "City", "Status"];

  it("maps header names to their column indices", () => {
    expect(resolveColumnIndices(headers, ["Status", "Name"])).toEqual([2, 0]);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveColumnIndices(headers, ["  status "])).toEqual([2]);
  });

  it("drops names with no matching header", () => {
    expect(resolveColumnIndices(headers, ["Status", "Ghost"])).toEqual([2]);
  });

  it("resolves against the current order, so a reordered column still matches", () => {
    const reordered = ["Status", "Name", "City"];
    expect(resolveColumnIndices(reordered, ["Status"])).toEqual([0]);
  });
});

describe("computeWatchedColumns (ignore set → watched indices)", () => {
  const headers = ["Name", "City", "Status"];

  it("returns undefined (watch whole row) when nothing is ignored", () => {
    expect(computeWatchedColumns(headers, [])).toBeUndefined();
  });

  it("watches every column except the ignored ones", () => {
    // Ignore Name + City → watch only Status (index 2).
    expect(computeWatchedColumns(headers, ["Name", "City"])).toEqual([2]);
  });

  it("returns an empty array (watch nothing) when every column is ignored", () => {
    expect(computeWatchedColumns(headers, ["Name", "City", "Status"])).toEqual(
      [],
    );
  });

  it("ignores names that don't match a header", () => {
    expect(computeWatchedColumns(headers, ["Ghost"])).toEqual([0, 1, 2]);
  });
});

describe("sheetsPollIdempotencyKey", () => {
  const base = { spreadsheetId: "sheet1", rowIndex: 5, pollToken: "T" };

  it("appends: a different row at the SAME index yields a different key (so an index reused after a delete still fires)", () => {
    const a = sheetsPollIdempotencyKey({
      ...base,
      changeType: "added",
      row: ["old"],
    });
    const b = sheetsPollIdempotencyKey({
      ...base,
      changeType: "added",
      row: ["new"],
    });
    expect(a).not.toEqual(b);
  });

  it("appends: identical content at the same index is stable (dedups retries) and ignores the poll token", () => {
    const a = sheetsPollIdempotencyKey({
      spreadsheetId: "sheet1",
      rowIndex: 5,
      changeType: "added",
      row: ["same"],
      pollToken: "one",
    });
    const b = sheetsPollIdempotencyKey({
      spreadsheetId: "sheet1",
      rowIndex: 5,
      changeType: "added",
      row: ["same"],
      pollToken: "two",
    });
    expect(a).toEqual(b);
  });

  it("edits: keys on the poll token, so re-editing a cell back to a prior value still fires", () => {
    // Same row, same content, two different polls → distinct keys → not deduped.
    const first = sheetsPollIdempotencyKey({
      spreadsheetId: "sheet1",
      rowIndex: 2,
      changeType: "updated",
      row: ["Done"],
      pollToken: "100",
    });
    const laterRepeat = sheetsPollIdempotencyKey({
      spreadsheetId: "sheet1",
      rowIndex: 2,
      changeType: "updated",
      row: ["Done"],
      pollToken: "200",
    });
    expect(first).toBe("google_sheets:sheet1:2:100");
    expect(first).not.toBe(laterRepeat);
  });

  it("edits: the same poll token dedups a step retry regardless of content", () => {
    const a = sheetsPollIdempotencyKey({
      spreadsheetId: "sheet1",
      rowIndex: 2,
      changeType: "updated",
      row: ["Done"],
      pollToken: "100",
    });
    const b = sheetsPollIdempotencyKey({
      spreadsheetId: "sheet1",
      rowIndex: 2,
      changeType: "updated",
      row: ["Pending"],
      pollToken: "100",
    });
    expect(a).toBe(b);
  });
});

describe("rowValuesByHeader", () => {
  const header = ["Name", "Estimated Amount", "Status"];

  it("keys cells by trimmed header name", () => {
    expect(rowValuesByHeader(header, ["Alice", "3500", "Done"])).toEqual({
      Name: "Alice",
      "Estimated Amount": "3500",
      Status: "Done",
    });
  });

  it("fills missing trailing cells with empty strings", () => {
    expect(rowValuesByHeader(header, ["Alice"])).toEqual({
      Name: "Alice",
      "Estimated Amount": "",
      Status: "",
    });
  });

  it("drops blank header columns", () => {
    expect(rowValuesByHeader(["Name", "", "Status"], ["a", "b", "c"])).toEqual({
      Name: "a",
      Status: "c",
    });
  });
});

describe("readSnapshot", () => {
  it("reads the current { sig, cols, header, cellHashes } shape", () => {
    expect(
      readSnapshot({
        sig: '["status"]',
        cols: "[1]",
        header: ["Name", "Status"],
        cellHashes: [["a"], ["b", "c"]],
      }),
    ).toEqual({
      cellHashes: [["a"], ["b", "c"]],
      projection: { names: '["status"]', cols: "[1]" },
      header: ["Name", "Status"],
    });
  });

  it("reads a pre-`cols`/`header` snapshot with the name identity only", () => {
    // Written before the index identity and stored header existed: still
    // comparable by name, so deploying them costs no re-baseline.
    expect(readSnapshot({ sig: "*", cellHashes: [["a"], ["b"]] })).toEqual({
      cellHashes: [["a"], ["b"]],
      projection: { names: "*", cols: null },
      header: null,
    });
  });

  it("lifts the legacy per-row { sig, hashes } shape to a re-seed placeholder (projection dropped)", () => {
    // The projection is dropped so the guard suppresses this poll's edits and
    // re-seeds real cell hashes; the row count is preserved so appends still fire.
    expect(readSnapshot({ sig: "*", hashes: ["a", "b"] })).toEqual({
      cellHashes: [["a"], ["b"]],
      projection: null,
      header: null,
    });
  });

  it("lifts the oldest legacy bare array the same way (re-seeds once)", () => {
    expect(readSnapshot(["a", "b"])).toEqual({
      cellHashes: [["a"], ["b"]],
      projection: null,
      header: null,
    });
  });

  it("treats null / non-snapshot values as no snapshot (first-poll baseline)", () => {
    const none = { cellHashes: null, projection: null, header: null };
    expect(readSnapshot(null)).toEqual(none);
    expect(readSnapshot("garbage")).toEqual(none);
    expect(readSnapshot({ nope: 1 })).toEqual(none);
  });
});

describe("detectRenamedColumns", () => {
  it("detects a column renamed in place", () => {
    expect(
      detectRenamedColumns(
        ["Name", "City", "Status"],
        ["Name", "Town", "Status"],
      ),
    ).toEqual(new Map([[1, "Town"]]));
  });

  it("detects several renames at once", () => {
    expect(detectRenamedColumns(["A", "B", "C"], ["A", "X", "Y"])).toEqual(
      new Map([
        [1, "X"],
        [2, "Y"],
      ]),
    );
  });

  it("reports nothing for a pure reorder (every name survives)", () => {
    expect(detectRenamedColumns(["A", "B", "C"], ["C", "A", "B"])).toEqual(
      new Map(),
    );
  });

  it("reports nothing when a column is deleted and its neighbour shifts in", () => {
    // B is gone and C now sits at index 1. Claiming that as "B renamed to C"
    // would ignore a column the user still watches.
    expect(detectRenamedColumns(["A", "B", "C"], ["A", "C"])).toEqual(
      new Map(),
    );
  });

  it("reports nothing for a delete plus an unrelated add (position moved)", () => {
    expect(detectRenamedColumns(["A", "B", "C"], ["A", "C", "D"])).toEqual(
      new Map(),
    );
  });

  it("detects a rename even when a column is appended in the same window", () => {
    expect(detectRenamedColumns(["A", "B", "C"], ["A", "X", "C", "D"])).toEqual(
      new Map([[1, "X"]]),
    );
  });

  it("ignores blank headers on either side", () => {
    expect(detectRenamedColumns(["A", "", "C"], ["A", "X", "C"])).toEqual(
      new Map(),
    );
    expect(detectRenamedColumns(["A", "B", "C"], ["A", "  ", "C"])).toEqual(
      new Map(),
    );
  });
});

// Renaming an IGNORED column used to stop its stored name from matching the live
// header, so the column silently became watched — the scoping the user configured
// was quietly lost (and the widened watched set suppressed that poll's edits too).
describe("healIgnoreColumns", () => {
  it("follows an ignored column through a rename", () => {
    expect(
      healIgnoreColumns(
        ["City"],
        ["Name", "City", "Status"],
        ["Name", "Town", "Status"],
      ),
    ).toEqual(["Town"]);
  });

  it("leaves untouched names alone while healing the renamed one", () => {
    expect(
      healIgnoreColumns(
        ["City", "Status"],
        ["Name", "City", "Status"],
        ["Name", "Town", "Status"],
      ),
    ).toEqual(["Town", "Status"]);
  });

  it("returns null when a rename doesn't touch an ignored column", () => {
    expect(
      healIgnoreColumns(
        ["Status"],
        ["Name", "City", "Status"],
        ["Full Name", "City", "Status"],
      ),
    ).toBeNull();
  });

  it("returns null for a reorder (names still resolve)", () => {
    expect(
      healIgnoreColumns(
        ["City"],
        ["Name", "City", "Status"],
        ["City", "Status", "Name"],
      ),
    ).toBeNull();
  });

  it("leaves a DELETED ignored column alone for the dialog to flag", () => {
    expect(
      healIgnoreColumns(
        ["City"],
        ["Name", "City", "Status"],
        ["Name", "Status"],
      ),
    ).toBeNull();
  });

  it("returns null with nothing ignored or no stored header", () => {
    expect(healIgnoreColumns([], ["Name"], ["Full Name"])).toBeNull();
    expect(healIgnoreColumns(["City"], [], ["Name", "Town"])).toBeNull();
  });

  it("matches the stored name case- and whitespace-insensitively", () => {
    expect(
      healIgnoreColumns([" city "], ["Name", "City"], ["Name", "Town"]),
    ).toEqual(["Town"]);
  });

  // The whole point of healing before scoping: the watched set is unchanged, so
  // the projection still matches and the poll's real edits aren't suppressed.
  it("keeps the watched projection stable across the rename", () => {
    const oldHeader = ["Name", "City", "Status"];
    const newHeader = ["Name", "Town", "Status"];
    const healed = healIgnoreColumns(["City"], oldHeader, newHeader);

    expect(
      projectionsComparable(
        sheetsProjection(oldHeader, computeWatchedColumns(oldHeader, ["City"])),
        sheetsProjection(
          newHeader,
          computeWatchedColumns(newHeader, healed ?? []),
        ),
      ),
    ).toBe(true);
  });
});

describe("sheetsProjection / projectionsComparable", () => {
  const comparable = (
    before: { header: string[]; watch?: number[] },
    after: { header: string[]; watch?: number[] },
  ) =>
    projectionsComparable(
      sheetsProjection(before.header, before.watch),
      sheetsProjection(after.header, after.watch),
    );

  it("is '*' on both identities for the whole-row (unscoped) projection", () => {
    expect(sheetsProjection(["Name", "City"], undefined)).toEqual({
      names: "*",
      cols: "*",
    });
  });

  it("stays comparable across a column reorder (the name identity holds)", () => {
    // Watch Name + Status. Before: indices [0,2]; after reorder: indices [0,1].
    expect(
      comparable(
        { header: ["Name", "City", "Status"], watch: [0, 2] },
        { header: ["Name", "Status", "City"], watch: [0, 1] },
      ),
    ).toBe(true);
  });

  it("stays comparable across a watched-column RENAME (the index identity holds)", () => {
    expect(
      comparable(
        { header: ["Name", "City", "Status"], watch: [0, 2] },
        { header: ["Full Name", "City", "Status"], watch: [0, 2] },
      ),
    ).toBe(true);
  });

  it("is not comparable when a watched column is added", () => {
    expect(
      comparable(
        { header: ["Name", "City"], watch: [0] },
        { header: ["Name", "City", "Status"], watch: [0, 2] },
      ),
    ).toBe(false);
  });

  it("is not comparable when renaming an IGNORED column widens the watched set", () => {
    // "City" was ignored; renamed, it stops matching the ignore list and becomes
    // watched — both identities move, because the positions really do change.
    expect(
      comparable(
        { header: ["Name", "City", "Status"], watch: [0, 2] },
        { header: ["Name", "Town", "Status"], watch: [0, 1, 2] },
      ),
    ).toBe(false);
  });

  it("is never comparable against an unknown (legacy) projection", () => {
    expect(projectionsComparable(null, sheetsProjection(["Name"], [0]))).toBe(
      false,
    );
  });

  it("falls back to the name identity when the stored index one predates `cols`", () => {
    const current = sheetsProjection(["Name", "Status"], [0, 1]);
    expect(
      projectionsComparable({ names: current.names, cols: null }, current),
    ).toBe(true);
    expect(
      projectionsComparable({ names: '["other"]', cols: null }, current),
    ).toBe(false);
  });
});

describe("planSheetsPollChanges — stale projection guard", () => {
  it("suppresses edits but still fires appends when the projection changed", () => {
    const oldRows = [["Name"], ["a"], ["b"]];
    // A column was added and its cells filled, so every row's scoped hash would
    // otherwise differ — a false edit storm. The projection differs, so no edits.
    const newRows = [
      ["Name", "Status"],
      ["a", "x"],
      ["b", "y"],
      ["c", "z"], // appended row
    ];
    const { changes } = planSheetsPollChanges({
      rows: newRows,
      lastRowCount: oldRows.length,
      oldCellHashes: cells(oldRows, [0]),
      triggerOn: "added_or_updated",
      watchColumns: [0, 1],
      oldProjection: sheetsProjection(["Name"], [0]),
      newProjection: sheetsProjection(["Name", "Status"], [0, 1]),
    });

    // No spurious "updated" for rows 2/3; the appended row 4 still fires.
    expect(changes).toEqual([
      { rowIndex: 4, changeType: "added", changedColumns: [] },
    ]);
  });

  it("fires edits normally when the projection is unchanged", () => {
    const before = [
      ["Name", "Status"],
      ["a", "x"],
      ["b", "y"],
    ];
    const after = [
      ["Name", "Status"],
      ["a", "x"],
      ["b", "CHANGED"],
    ];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldCellHashes: cells(before, [1]),
      triggerOn: "added_or_updated",
      watchColumns: [1],
      oldProjection: sheetsProjection(before[0], [1]),
      newProjection: sheetsProjection(after[0], [1]),
    });

    // Status is position 0 of the [1] projection → real column index 1.
    expect(changes).toEqual([
      { rowIndex: 3, changeType: "updated", changedColumns: [1] },
    ]);
  });

  // A header rename used to move the name signature and re-baseline the whole
  // sheet, so every genuine row edit in the same 5-minute poll window was
  // silently swallowed. The watched INDICES are untouched by a rename, so the
  // snapshot stays comparable and those edits fire.
  it("still fires row edits made in the same poll as a header rename", () => {
    const before = [
      ["Name", "City", "Status"],
      ["a", "here", "x"],
      ["b", "there", "y"],
    ];
    const after = [
      ["Full Name", "City", "Status"], // header renamed
      ["a", "here", "x"],
      ["b", "there", "CHANGED"], // ...and a real edit in the same window
    ];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      // "City" ignored → scoped projection, which is what used to trip the guard.
      oldCellHashes: cells(before, [0, 2]),
      triggerOn: "added_or_updated",
      watchColumns: [0, 2],
      oldProjection: sheetsProjection(before[0], [0, 2]),
      newProjection: sheetsProjection(after[0], [0, 2]),
    });

    expect(changes).toEqual([
      { rowIndex: 3, changeType: "updated", changedColumns: [2] },
    ]);
  });

  it("does not report the renamed header itself as a change", () => {
    const before = [
      ["Name", "Status"],
      ["a", "x"],
    ];
    const after = [
      ["Full Name", "Status"],
      ["a", "x"],
    ];
    const { changes } = planSheetsPollChanges({
      rows: after,
      lastRowCount: before.length,
      oldCellHashes: cells(before, [0, 1]),
      triggerOn: "added_or_updated",
      watchColumns: [0, 1],
      oldProjection: sheetsProjection(before[0], [0, 1]),
      newProjection: sheetsProjection(after[0], [0, 1]),
    });

    expect(changes).toEqual([]);
  });
});

describe("changedFieldNames", () => {
  const header = ["Name", "City", "Status"];

  it("maps changed column indices to their header names", () => {
    expect(changedFieldNames(header, [2, 0])).toEqual(["Status", "Name"]);
  });

  it("falls back to Column N for a blank or missing header", () => {
    expect(changedFieldNames(["Name", "", "Status"], [1])).toEqual([
      "Column 2",
    ]);
    expect(changedFieldNames(header, [5])).toEqual(["Column 6"]);
  });

  it("is empty for no changed columns (e.g. an added row)", () => {
    expect(changedFieldNames(header, [])).toEqual([]);
  });
});
