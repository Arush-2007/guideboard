import type { Connection, Edge, Node } from "@xyflow/react";
import { triggerNodeTypeSet } from "@/config/node-options";
import type { NodeType } from "@/generated/prisma";

/**
 * Would adding a `source -> target` edge close a loop? Walk forward from
 * `target` over the existing edges (`edge.source -> edge.target`); if that walk
 * can already reach `source`, the new edge would create a cycle. Mirrors the
 * semantics of `topologicalSort` in `src/inngest/utils.ts` (which rejects cyclic
 * graphs at runtime) but stays client-only — no engine/server import.
 *
 * Iterative stack + visited set, so a graph that already contains a cycle can't
 * make this hang.
 */
export const wouldCreateCycle = (
  source: string,
  target: string,
  edges: Edge[],
): boolean => {
  // Forward adjacency: node id -> ids it points at.
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source);
    if (list) {
      list.push(edge.target);
    } else {
      outgoing.set(edge.source, [edge.target]);
    }
  }

  const visited = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === source) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const next = outgoing.get(current);
    if (next) {
      stack.push(...next);
    }
  }
  return false;
};

/**
 * The single rule set for draw-time connection validation. Returns a short,
 * user-facing reason the connection is rejected, or `null` when it's allowed.
 * One function powers both the `isValidConnection` predicate and its toast, so
 * the rules live in exactly one place.
 */
export const invalidConnectionReason = (
  connection: Connection,
  nodes: Node[],
  edges: Edge[],
): string | null => {
  const { source, target } = connection;
  if (!source || !target) {
    return "That connection isn't valid";
  }
  if (source === target) {
    return "A node can't connect to itself";
  }

  const targetNode = nodes.find((node) => node.id === target);
  if (targetNode?.type && triggerNodeTypeSet.has(targetNode.type as NodeType)) {
    return "Triggers can't receive a connection";
  }

  if (wouldCreateCycle(source, target, edges)) {
    return "That connection would create a loop";
  }

  return null;
};
