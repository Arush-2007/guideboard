import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";
import type { NodeStatus } from "@/components/react-flow/node-status-indicator";
import { nodeStatusMapAtom } from "@/features/editor/store/atoms";

/**
 * Latest realtime status for a single node.
 *
 * Reads the node's own slice of the shared status map via `selectAtom`. Because
 * the selected value is a primitive status string, selectAtom's default
 * `Object.is` equality means a status update re-renders ONLY the affected node,
 * not every node on the canvas. The subscriptions that populate the map are
 * owned by the per-channel <NodeStatusSubscriber>s mounted in the editor.
 */
export function useNodeStatus(nodeId: string): NodeStatus {
  const statusAtom = useMemo(
    () =>
      selectAtom(
        nodeStatusMapAtom,
        (map): NodeStatus => map[nodeId] ?? "initial",
      ),
    [nodeId],
  );

  return useAtomValue(statusAtom);
}
