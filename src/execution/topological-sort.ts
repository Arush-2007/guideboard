import toposort from "toposort";
import type { Connection, Node } from "@/generated/prisma";

/**
 * Orders a workflow's nodes so every node runs after everything feeding it.
 *
 * Lives here rather than in `src/inngest/utils.ts` — its home until Step 4 of
 * the runtime split — because it is pure graph code that both runtimes need,
 * and `utils.ts` imports `./client` for VALUE. Importing this from there meant
 * constructing the Inngest client and its realtime middleware just to sort a
 * graph. The codebase already knew: `src/lib/upstream-fields.ts` reimplements
 * what it needs rather than pay that cost.
 */
export const topologicalSort = (
  nodes: Node[],
  connections: Connection[],
): Node[] => {
  // If no connections, return node as-is (they're all independent)
  if (connections.length === 0) {
    return nodes;
  }

  // Create edges array for toposort (real connections only — self-edges are
  // treated as cycles by toposort, so orphan nodes are appended afterwards).
  const edges: [string, string][] = connections.map((conn) => [
    conn.fromNodeId,
    conn.toNodeId,
  ]);

  // Perform topological sort
  let sortedNodeIds: string[];
  try {
    sortedNodeIds = toposort(edges);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Cyclic")) {
      throw new Error("Workflow contains a cycle");
    }
    throw error;
  }

  // Map sorted IDs back to node objects
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const sorted = sortedNodeIds
    .map((id) => nodeMap.get(id))
    .filter((n): n is Node => Boolean(n));

  // Append nodes that aren't part of any connection, preserving input order.
  const includedIds = new Set(sortedNodeIds);
  for (const node of nodes) {
    if (!includedIds.has(node.id)) {
      sorted.push(node);
    }
  }

  return sorted;
};
