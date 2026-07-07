import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  commit,
  HISTORY_LIMIT,
  type HistorySnapshot,
  type HistoryState,
  initialHistory,
  redo,
  toSnapshot,
  undo,
} from "./history";

// A minimal snapshot for exercising the reducer: only `key` drives its logic.
const snap = (key: string): HistorySnapshot => ({ nodes: [], edges: [], key });

// Seed a state whose present is `key`, with no undo/redo history.
const seeded = (key: string): HistoryState =>
  commit(initialHistory(), snap(key));

describe("history reducer", () => {
  it("seeds the present on first commit without recording an undo step", () => {
    const state = commit(initialHistory(), snap("a"));
    expect(state.present?.key).toBe("a");
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(canUndo(state)).toBe(false);
  });

  it("ignores a commit with the same key as the present (no-op, same ref)", () => {
    const state = seeded("a");
    expect(commit(state, snap("a"))).toBe(state);
  });

  it("pushes the previous present onto past when the key changes", () => {
    const state = commit(seeded("a"), snap("b"));
    expect(state.present?.key).toBe("b");
    expect(state.past.map((s) => s.key)).toEqual(["a"]);
    expect(canUndo(state)).toBe(true);
  });

  it("clears the redo stack on a fresh commit", () => {
    let state = commit(seeded("a"), snap("b")); // past:[a] present:b
    state = undo(state); // past:[] present:a future:[b]
    expect(canRedo(state)).toBe(true);
    state = commit(state, snap("c")); // fresh edit invalidates redo
    expect(state.present?.key).toBe("c");
    expect(state.future).toEqual([]);
    expect(canRedo(state)).toBe(false);
    expect(state.past.map((s) => s.key)).toEqual(["a"]);
  });

  it("round-trips through undo and redo", () => {
    let state = commit(seeded("a"), snap("b"));
    state = commit(state, snap("c")); // past:[a,b] present:c

    state = undo(state);
    expect(state.present?.key).toBe("b");
    state = undo(state);
    expect(state.present?.key).toBe("a");
    expect(canUndo(state)).toBe(false);

    state = redo(state);
    expect(state.present?.key).toBe("b");
    state = redo(state);
    expect(state.present?.key).toBe("c");
    expect(canRedo(state)).toBe(false);
  });

  it("returns the same reference when there is nothing to undo or redo", () => {
    const state = seeded("a");
    expect(undo(state)).toBe(state);
    expect(redo(state)).toBe(state);
    expect(undo(initialHistory())).toEqual(initialHistory());
  });

  it("caps the past stack at HISTORY_LIMIT, dropping the oldest", () => {
    let state = seeded("k0");
    // Commit well past the cap; each distinct key adds one undo step.
    for (let i = 1; i <= HISTORY_LIMIT + 10; i++) {
      state = commit(state, snap(`k${i}`));
    }
    expect(state.past.length).toBe(HISTORY_LIMIT);
    // Oldest surviving entry is the one exactly HISTORY_LIMIT steps back.
    const present = HISTORY_LIMIT + 10;
    expect(state.past[0].key).toBe(`k${present - HISTORY_LIMIT}`);
    expect(state.past.at(-1)?.key).toBe(`k${present - 1}`);
  });
});

describe("toSnapshot", () => {
  const node = (overrides: Partial<Node> & Pick<Node, "id">): Node => ({
    type: "HTTP_REQUEST",
    position: { x: 0, y: 0 },
    data: {},
    ...overrides,
  });

  it("keys identically to serializeSnapshot for the same canvas", () => {
    const a = toSnapshot([node({ id: "n1", data: { x: 1 } })], []);
    const b = toSnapshot([node({ id: "n1", data: { x: 1 } })], []);
    expect(a.key).toBe(b.key);
  });

  it("deep-clones node data so later in-place mutation can't corrupt history", () => {
    const data: Record<string, unknown> = { subject: "Heyy" };
    const captured = toSnapshot([node({ id: "n1", data })], []);

    data.subject = "Changed";

    expect((captured.nodes[0].data as Record<string, unknown>).subject).toBe(
      "Heyy",
    );
  });

  it("preserves the branching handle on edges", () => {
    const captured = toSnapshot(
      [],
      [
        {
          id: "e1",
          source: "a",
          target: "b",
          sourceHandle: "source-2",
        },
      ],
    );
    expect(captured.edges[0].sourceHandle).toBe("source-2");
  });
});
