import { describe, expect, it } from "vitest";
import {
  changedFieldNames,
  computeWatchedColumns,
  hashCells,
  planSheetsPollChanges,
  readSnapshot,
  resolveColumnIndices,
  rowValuesByHeader,
  sheetsPollIdempotencyKey,
  watchColumnsSignature,
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
  it("reads the current { sig, cellHashes } shape", () => {
    expect(readSnapshot({ sig: "*", cellHashes: [["a"], ["b", "c"]] })).toEqual(
      {
        cellHashes: [["a"], ["b", "c"]],
        sig: "*",
      },
    );
  });

  it("lifts the legacy per-row { sig, hashes } shape to a re-seed placeholder (sig dropped)", () => {
    // sig is dropped so the projection guard suppresses this poll's edits and
    // re-seeds real cell hashes; the row count is preserved so appends still fire.
    expect(readSnapshot({ sig: "*", hashes: ["a", "b"] })).toEqual({
      cellHashes: [["a"], ["b"]],
      sig: null,
    });
  });

  it("lifts the oldest legacy bare array the same way (re-seeds once)", () => {
    expect(readSnapshot(["a", "b"])).toEqual({
      cellHashes: [["a"], ["b"]],
      sig: null,
    });
  });

  it("treats null / non-snapshot values as no snapshot (first-poll baseline)", () => {
    expect(readSnapshot(null)).toEqual({ cellHashes: null, sig: null });
    expect(readSnapshot("garbage")).toEqual({ cellHashes: null, sig: null });
    expect(readSnapshot({ nope: 1 })).toEqual({ cellHashes: null, sig: null });
  });
});

describe("watchColumnsSignature", () => {
  it("is '*' for the whole-row (unscoped) projection", () => {
    expect(watchColumnsSignature(["Name", "City"], undefined)).toBe("*");
  });

  it("is identical after a column reorder (keyed on names, not indices)", () => {
    // Watch Name + Status. Before: indices [0,2]; after reorder: indices [0,1].
    const before = watchColumnsSignature(["Name", "City", "Status"], [0, 2]);
    const after = watchColumnsSignature(["Name", "Status", "City"], [0, 1]);
    expect(after).toBe(before);
  });

  it("changes when a watched column is added", () => {
    const before = watchColumnsSignature(["Name", "City"], [0]);
    const after = watchColumnsSignature(["Name", "City", "Status"], [0, 2]);
    expect(after).not.toBe(before);
  });
});

describe("planSheetsPollChanges — stale projection (signature) guard", () => {
  it("suppresses edits but still fires appends when the projection changed", () => {
    const oldRows = [["Name"], ["a"], ["b"]];
    // A column was added and its cells filled, so every row's scoped hash would
    // otherwise differ — a false edit storm. The signature differs, so no edits.
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
      oldSignature: "name",
      newSignature: "name status",
    });

    // No spurious "updated" for rows 2/3; the appended row 4 still fires.
    expect(changes).toEqual([
      { rowIndex: 4, changeType: "added", changedColumns: [] },
    ]);
  });

  it("fires edits normally when the signature is unchanged", () => {
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
      oldSignature: "status",
      newSignature: "status",
    });

    // Status is position 0 of the [1] projection → real column index 1.
    expect(changes).toEqual([
      { rowIndex: 3, changeType: "updated", changedColumns: [1] },
    ]);
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
