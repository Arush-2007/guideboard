import type { Edge, Node } from "@xyflow/react";
import { serializeSnapshot } from "./snapshot";

/**
 * Maximum number of undo steps retained. Once the `past` stack exceeds this the
 * oldest entries are dropped from the bottom, so history can't grow unbounded on
 * a long editing session.
 */
export const HISTORY_LIMIT = 50;

/**
 * A restorable, deep-cloned view of the canvas plus its comparison key.
 *
 * `nodes`/`edges` keep only the fields the editor persists and can restore, and
 * are cloned so that React Flow's later in-place mutations (drag positions,
 * `measured`, `selected`) can never reach back and corrupt a stored entry. `key`
 * is the same canonical serialization dirty-tracking uses (`serializeSnapshot`),
 * so two structurally-equal canvases collapse to a single history entry.
 */
export type HistorySnapshot = {
  nodes: Node[];
  edges: Edge[];
  key: string;
};

/**
 * The undo/redo stacks plus the current canvas. `present` is `null` only before
 * the first canvas has been observed; after that it always mirrors the live
 * canvas at the last settle point.
 */
export type HistoryState = {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
  present: HistorySnapshot | null;
};

export const initialHistory = (): HistoryState => ({
  past: [],
  future: [],
  present: null,
});

const cloneData = (data: Node["data"]): Record<string, unknown> =>
  data == null ? {} : (structuredClone(data) as Record<string, unknown>);

/**
 * Build a restorable snapshot from the live canvas: keep only persisted fields,
 * deep-clone the mutable ones, and attach the canonical dedup key. Handles
 * (`sourceHandle`) carry branching routing, so they are preserved.
 */
export const toSnapshot = (nodes: Node[], edges: Edge[]): HistorySnapshot => ({
  nodes: nodes.map(
    (node) =>
      ({
        id: node.id,
        type: node.type,
        position: { x: node.position.x, y: node.position.y },
        data: cloneData(node.data),
      }) as Node,
  ),
  edges: edges.map(
    (edge) =>
      ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      }) as Edge,
  ),
  key: serializeSnapshot(nodes, edges),
});

/**
 * Record a settled canvas state. Returns the *same* state reference when there
 * is nothing to record, so callers can cheaply detect a no-op.
 *
 * - First observation (`present === null`) seeds the present without pushing an
 *   undo step — opening a workflow is not an editable action.
 * - An identical key (a selection toggle, or a drag that landed back in the same
 *   grid cell) records nothing.
 * - Otherwise the previous present becomes an undo step, the redo stack is
 *   cleared, and the stack is capped from the bottom.
 */
export const commit = (
  state: HistoryState,
  snapshot: HistorySnapshot,
): HistoryState => {
  if (state.present === null) {
    return { past: state.past, future: state.future, present: snapshot };
  }
  if (snapshot.key === state.present.key) {
    return state;
  }
  const past = [...state.past, state.present];
  if (past.length > HISTORY_LIMIT) {
    past.splice(0, past.length - HISTORY_LIMIT);
  }
  return { past, future: [], present: snapshot };
};

/**
 * Step one entry back. No-op (returns the same reference) when there is nothing
 * to undo.
 */
export const undo = (state: HistoryState): HistoryState => {
  if (state.present === null || state.past.length === 0) {
    return state;
  }
  const past = [...state.past];
  const previous = past.pop() as HistorySnapshot;
  return {
    past,
    future: [state.present, ...state.future],
    present: previous,
  };
};

/**
 * Step one entry forward. No-op (returns the same reference) when there is
 * nothing to redo.
 */
export const redo = (state: HistoryState): HistoryState => {
  if (state.present === null || state.future.length === 0) {
    return state;
  }
  const [next, ...future] = state.future;
  return {
    past: [...state.past, state.present],
    future,
    present: next,
  };
};

export const canUndo = (state: HistoryState): boolean => state.past.length > 0;
export const canRedo = (state: HistoryState): boolean =>
  state.future.length > 0;
