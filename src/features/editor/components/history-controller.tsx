"use client";

import { type Edge, type Node, useStore } from "@xyflow/react";
import { useSetAtom } from "jotai";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from "react";
import {
  canRedo,
  canUndo,
  commit,
  type HistorySnapshot,
  type HistoryState,
  redo as redoState,
  toSnapshot,
  undo as undoState,
} from "../lib/history";
import { historyControlsAtom } from "../store/atoms";

type HistoryControllerProps = {
  setNodes: Dispatch<SetStateAction<Node[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  initialNodes: Node[];
  initialEdges: Edge[];
  workflowId: string;
};

// Fresh, independent node/edge objects for a restore, so React Flow's later
// in-place mutations (drag positions, `measured`, `selected`) can never reach
// back into the pristine history entry we still hold for a future undo/redo.
const materialize = (snapshot: HistorySnapshot) => ({
  nodes: snapshot.nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: structuredClone(node.data),
  })),
  edges: snapshot.edges.map((edge) => ({ ...edge })),
});

/**
 * Owns undo/redo for the canvas. Renders nothing; mounted inside
 * <ReactFlowProvider> next to <DirtyTracker>.
 *
 * History is captured from the React Flow store — the single source of truth the
 * canvas, the Save button (`editor.getNodes()`), and <DirtyTracker> already read.
 * That is deliberate: the two most important mutation paths, config-dialog saves
 * and menu-deletes, both call `useReactFlow().setNodes` directly and never reach
 * editor.tsx's `onNodesChange`, so observing the store is the only way to record
 * every path with one uniform mechanism (a push-based capture would need mixed
 * hooks at 25+ sites — the classic corrupt-history trap).
 *
 * The stacks live in a ref (synchronous, single-owner) rather than an atom, so an
 * undo/redo can advance `present` *before* it writes the canvas — the capture
 * effect that fires from that write then sees no change and does not re-record.
 */
export const HistoryController = ({
  setNodes,
  setEdges,
  initialNodes,
  initialEdges,
  workflowId,
}: HistoryControllerProps) => {
  const storeNodes = useStore((state) => state.nodes);
  const storeEdges = useStore((state) => state.edges);
  const setControls = useSetAtom(historyControlsAtom);

  const historyRef = useRef<HistoryState>({
    past: [],
    future: [],
    present: null,
  });
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // Seed `present` from the *persisted* workflow (the baseline the store will
  // hydrate to) and re-seed when a different workflow is opened in the same
  // editor instance. Done during render — before the capture effect runs — so
  // the observer never sees a null present, and `armed` gates it from recording
  // anything until the store has caught up (see the capture effect). Mutating a
  // ref during render is the sanctioned pattern for deriving state from props.
  const seededWorkflow = useRef<string | null>(null);
  const initialKeyRef = useRef<string>("");
  const armed = useRef(false);
  if (seededWorkflow.current !== workflowId) {
    seededWorkflow.current = workflowId;
    const present = toSnapshot(initialNodes, initialEdges);
    historyRef.current = { past: [], future: [], present };
    initialKeyRef.current = present.key;
    armed.current = false;
  }

  // The single, uniform history recorder. It ignores the mount-time hydration
  // churn (the store transitions empty → loaded): recording only *arms* once the
  // store first matches the loaded workflow, so the transient empty store is
  // never captured as a baseline or mistaken for an edit. After that, mid-drag
  // ticks are suppressed via the per-node `dragging` flag so a drag is one undo
  // step (never one per pixel), a drag landing back in the same grid cell records
  // nothing (identical key), and selection toggles never change the key.
  useEffect(() => {
    if (storeNodes.some((node) => node.dragging)) {
      return;
    }
    const snapshot = toSnapshot(storeNodes, storeEdges);
    if (!armed.current) {
      if (snapshot.key === initialKeyRef.current) {
        armed.current = true;
      }
      return;
    }
    const next = commit(historyRef.current, snapshot);
    if (next === historyRef.current) {
      return;
    }
    historyRef.current = next;
    bump();
  }, [storeNodes, storeEdges]);

  // Apply a history entry to the canvas by writing editor.tsx's controlled
  // `useState`. That drives the `nodes` prop, which React Flow syncs into its
  // store — so the canvas, Save button, and <DirtyTracker> (all store readers)
  // update, and `useState` stays authoritative so the next interactive change
  // can't clobber the restore with a stale prop. Dirty state auto-recomputes:
  // undoing back to the saved baseline reads as not-dirty because <DirtyTracker>
  // compares the store against the saved snapshot, not a boolean.
  const restore = useCallback(
    (snapshot: HistorySnapshot) => {
      const { nodes, edges } = materialize(snapshot);
      setNodes(nodes);
      setEdges(edges);
    },
    [setNodes, setEdges],
  );

  const doUndo = useCallback(() => {
    const next = undoState(historyRef.current);
    if (next === historyRef.current || next.present === null) {
      return;
    }
    historyRef.current = next; // advance present first; the capture effect no-ops
    restore(next.present);
    bump();
  }, [restore]);

  const doRedo = useCallback(() => {
    const next = redoState(historyRef.current);
    if (next === historyRef.current || next.present === null) {
      return;
    }
    historyRef.current = next;
    restore(next.present);
    bump();
  }, [restore]);

  // Publish the controls so the buttons — and, next, the Ctrl+Z/Ctrl+Shift+Z
  // shortcuts — drive this one engine. Republishes only when availability flips
  // (not on every drag tick): `doUndo`/`doRedo` are stable and read the live ref.
  const undoAvailable = canUndo(historyRef.current);
  const redoAvailable = canRedo(historyRef.current);
  useEffect(() => {
    setControls({
      undo: doUndo,
      redo: doRedo,
      canUndo: undoAvailable,
      canRedo: redoAvailable,
    });
  }, [undoAvailable, redoAvailable, doUndo, doRedo, setControls]);

  useEffect(() => () => setControls(null), [setControls]);

  return null;
};
