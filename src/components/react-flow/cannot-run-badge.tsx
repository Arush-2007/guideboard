"use client";

import { CornerWarningBadge } from "@/components/react-flow/corner-warning-badge";
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
 * Shares the corner (and `<CornerWarningBadge>`) with the other two warnings, so
 * the canvas keeps one visual vocabulary for "this node needs your attention" —
 * which also means only one may show. This YIELDS to an invalid config: that's
 * the more actionable problem, and it stops a node ever showing two overlapping
 * triangles. The tooltips distinguish them.
 */
export const CannotRunBadge = ({ nodeId }: { nodeId: string }) => {
  const reason = useUnrunnableReason(nodeId);
  const hasInvalidConfig = useHasInvalidConfig(nodeId);

  if (!reason || hasInvalidConfig) return null;

  return <CornerWarningBadge label={reason} />;
};
