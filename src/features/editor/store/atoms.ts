import type { ReactFlowInstance } from "@xyflow/react";
import { atom } from "jotai";
import type { NodeStatus } from "@/components/react-flow/node-status-indicator";
import type { NodeType } from "@/generated/prisma";

export const editorAtom = atom<ReactFlowInstance | null>(null);

// Frozen serialization of the canvas as it was last persisted (on initial load
// and after every successful save). `null` until the editor has loaded a
// workflow. Held as a string (not an object) so it can never alias — and so can
// never be silently mutated by — the live node data. Dirty-tracking compares
// the live canvas's serialization against this.
export const lastSavedSnapshotAtom = atom<string | null>(null);

// Whether the canvas differs from `lastSavedSnapshotAtom`. Written solely by
// <DirtyTracker> (which compares the React Flow store against the baseline) and
// read by the header save button and the navigation guard, which live in
// sibling subtrees.
export const isDirtyAtom = atom(false);

// The pending in-app navigation target while a save-guard dialog is open, or
// `null` when no guard is pending. A guarded link/sidebar item sets this when
// the editor is dirty; <NavGuardDialog> (mounted in the editor) reacts to it.
export const navGuardTargetAtom = atom<string | null>(null);

// Undo/redo actions plus their availability, published by <HistoryController>
// (its single writer) which owns the history stacks off the React Flow store.
// Read by the canvas undo/redo buttons — and, next, the Ctrl+Z/Ctrl+Shift+Z
// shortcuts — so every trigger drives one engine. `null` until the controller
// mounts.
export type HistoryControls = {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};
export const historyControlsAtom = atom<HistoryControls | null>(null);

// A node that has been chosen from the selector but not yet placed on the
// canvas. It waits in the staging tray until the user drags it onto the canvas,
// at which point a real React Flow node is created and the staged entry removed.
export type StagedNode = {
  id: string;
  type: NodeType;
};

// Holds the nodes currently waiting in the staging tray. Kept in the editor
// store (not React Flow state) so selecting nodes doesn't churn the canvas, and
// so the selector and the tray share one source of truth.
export const stagedNodesAtom = atom<StagedNode[]>([]);

// Drag-and-drop payload key for staged nodes. Shared by the tray (sets it on
// dragstart) and the canvas drop handler (reads it) so the contract lives in
// one place.
export const STAGED_NODE_MIME = "application/guideboard-staged-node";

// Shared map of nodeId -> latest realtime status. Populated by the per-channel
// <NodeStatusSubscriber>s mounted once in the editor; each node reads only its
// own slice via useNodeStatus(nodeId), so a status update re-renders just that
// node instead of every node on the canvas.
export const nodeStatusMapAtom = atom<Record<string, NodeStatus>>({});

// Shared map of nodeId -> config-validation issue summaries, present ONLY for
// nodes whose `data` fails its `node-schemas.ts` schema. Written solely by
// <ConfigValidator> (which validates the React Flow store against the registry).
// Each node reads only whether *it* is invalid via useHasInvalidConfig(nodeId)
// — a boolean slice, so fixing one node re-renders just that node, not the whole
// canvas. The Execute button reads the whole map to gate + name offenders.
export const invalidNodeConfigAtom = atom<Record<string, string[]>>({});
