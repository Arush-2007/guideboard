import type { ReactFlowInstance } from "@xyflow/react";
import { atom } from "jotai";
import type { NodeStatus } from "@/components/react-flow/node-status-indicator";
import type { NodeType } from "@/generated/prisma";

export const editorAtom = atom<ReactFlowInstance | null>(null);

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
