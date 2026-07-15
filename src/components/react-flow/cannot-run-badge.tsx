"use client";

import { TriangleAlert } from "lucide-react";
import { useHasInvalidConfig } from "@/features/executions/hooks/use-invalid-config";
import { useUnrunnableReason } from "@/features/executions/hooks/use-unrunnable";

/**
 * Amber warning for a canvas node that can never run as wired — one the engine
 * won't reach from any trigger, or a trigger that drives nothing. Clears the
 * moment the node is wired back up. The tooltip carries the specific reason (see
 * `unrunnableNodes` in `features/editor/lib/connectivity.ts`, which derives it
 * from the very same trigger set the engine roots on, so the canvas and the
 * engine can't disagree about what runs).
 *
 * Deliberately NOT shown for a node that merely has no downstream: that's the
 * last step of a normal workflow, and warning on it nags forever.
 *
 * Same warning triangle + corner as <NeedsConfigBadge>, so the canvas keeps one
 * visual vocabulary for "this node needs your attention". Because they share the
 * top-right corner, this badge YIELDS when the node also has an invalid config:
 * that's the more actionable problem, and it stops a node ever showing two
 * overlapping triangles. The tooltips distinguish the two.
 */
export const CannotRunBadge = ({ nodeId }: { nodeId: string }) => {
  const reason = useUnrunnableReason(nodeId);
  const hasInvalidConfig = useHasInvalidConfig(nodeId);

  if (!reason || hasInvalidConfig) return null;

  return (
    <span
      role="img"
      title={reason}
      aria-label={reason}
      className="absolute -right-2 -top-2 z-10 drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.35)]"
    >
      <TriangleAlert
        className="size-[18px] fill-amber-400 text-amber-950"
        strokeWidth={2.25}
      />
    </span>
  );
};
