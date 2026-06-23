import type { ReactFlowInstance } from "@xyflow/react";
import { atom } from "jotai";
import type { NodeStatus } from "@/components/react-flow/node-status-indicator";

export const editorAtom = atom<ReactFlowInstance | null>(null);

// Shared map of nodeId -> latest realtime status. Populated by the per-channel
// <NodeStatusSubscriber>s mounted once in the editor; each node reads only its
// own slice via useNodeStatus(nodeId), so a status update re-renders just that
// node instead of every node on the canvas.
export const nodeStatusMapAtom = atom<Record<string, NodeStatus>>({});
