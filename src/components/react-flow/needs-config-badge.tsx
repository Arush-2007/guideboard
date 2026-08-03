"use client";

import { CornerWarningBadge } from "@/components/react-flow/corner-warning-badge";
import { useHasInvalidConfig } from "@/features/executions/hooks/use-invalid-config";

/**
 * "Needs configuration" warning for a canvas node whose config fails its schema.
 * Reads only its own node's validity slice (a boolean) so a fix on one node
 * re-renders just that node. Renders nothing when the node is valid.
 *
 * Outranks the other two corner warnings — it is the only one that blocks
 * Execute outright — so it yields to nothing and they check it.
 */
export const NeedsConfigBadge = ({ nodeId }: { nodeId: string }) => {
  const hasInvalidConfig = useHasInvalidConfig(nodeId);

  if (!hasInvalidConfig) return null;

  return <CornerWarningBadge label="Needs configuration" />;
};
