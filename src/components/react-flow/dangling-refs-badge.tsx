"use client";

import { CornerWarningBadge } from "@/components/react-flow/corner-warning-badge";
import { useDanglingRefs } from "@/features/executions/hooks/use-dangling-refs";
import { useHasInvalidConfig } from "@/features/executions/hooks/use-invalid-config";
import { useUnrunnableReason } from "@/features/executions/hooks/use-unrunnable";
import { groupByField, humanizeFieldKey } from "@/lib/dangling-refs";

/**
 * Amber warning for a canvas node holding a DANGLING reference — a field naming
 * a step that can't reach it, which would render blank at run time.
 *
 * The point of showing it here, rather than only in the node's own save guard,
 * is that a node's config is only checked when the user opens and saves that
 * node. Duplicate a node, wire it to the wrong upstream, and hit the workflow
 * Save, and nothing had ever looked at it — the copy's `@<…>@` tokens came along
 * with the deep-copied `data` but none of the steps they name are behind it.
 * This appears the instant that happens.
 *
 * Shares the corner (and `<CornerWarningBadge>`) with the other two warnings, so
 * only one may show. This one is LAST: invalid config outranks it because that
 * blocks Execute outright, and so does "cannot run as wired", because a step
 * nothing reaches has a bigger problem than a value it can't fill. Wiring the
 * node up clears that one and reveals this. The tooltips distinguish all three.
 */
export const DanglingRefsBadge = ({ nodeId }: { nodeId: string }) => {
  const dangling = useDanglingRefs(nodeId);
  const hasInvalidConfig = useHasInvalidConfig(nodeId);
  const unrunnable = useUnrunnableReason(nodeId);

  if (dangling.length === 0 || hasInvalidConfig || unrunnable) return null;

  // By FIELD, not by value: one bad wire into a wide sheet breaks a mapping per
  // column, and a tooltip listing all of them is unreadable — the fields are
  // what the user has to go and open.
  const groups = groupByField(dangling);
  const detail = groups
    .map((group) => {
      const name = group.field ? humanizeFieldKey(group.field) : "This field";
      return group.refs.length > 1
        ? `${name} — ${group.refs.length} values`
        : `${name}: @<${group.refs[0].path}>@`;
    })
    .join("\n");
  const label =
    dangling.length > 1
      ? `${dangling.length} values can't reach this step — nothing before it produces them, so they will be blank:\n${detail}`
      : `This value can't reach this step — nothing before it produces it, so it will be blank:\n${detail}`;

  return <CornerWarningBadge label={label} />;
};
