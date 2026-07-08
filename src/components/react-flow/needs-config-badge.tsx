"use client";

import { TriangleAlert } from "lucide-react";
import { useHasInvalidConfig } from "@/features/executions/hooks/use-invalid-config";

/**
 * Amber "needs configuration" warning for a canvas node whose config fails its
 * schema. Reads only its own node's validity slice (a boolean) so a fix on one
 * node re-renders just that node. Renders nothing when the node is valid.
 *
 * A filled warning triangle (⚠) parked at the node's top-right corner: an amber
 * fill with a dark outline + exclamation is the conventional "warning" colorway
 * and reads cleanly on both the node (bg-card) and the canvas in either theme. A
 * drop shadow lifts it off the node. No enclosing circle — so nothing can look
 * off-center inside it.
 */
export const NeedsConfigBadge = ({ nodeId }: { nodeId: string }) => {
  const hasInvalidConfig = useHasInvalidConfig(nodeId);

  if (!hasInvalidConfig) return null;

  return (
    <span
      role="img"
      title="Needs configuration"
      aria-label="Needs configuration"
      className="absolute -right-2 -top-2 z-10 drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.35)]"
    >
      <TriangleAlert
        className="size-[18px] fill-amber-400 text-amber-950"
        strokeWidth={2.25}
      />
    </span>
  );
};
