import { triggerNodeTypeSet } from "@/config/node-options";
import { NodeType } from "@/generated/prisma";

type ConnNode = { id: string; type?: string | null };
type ConnEdge = { source: string; target: string };

/**
 * Map of nodeId -> why that node is mis-wired. Present ONLY for broken nodes; a
 * node absent from the map is fine.
 *
 * The rule is "isn't wired into the flow", not "has no downstream". A node with
 * no *outgoing* edge is perfectly legal — it's the last step of the workflow (a
 * final Slack notify), and warning on it would nag on every well-formed workflow
 * forever. What is genuinely broken is:
 *
 *  - a **trigger with no outgoing edge** — it fires, but drives nothing; and
 *  - an **action with no incoming edge** — nothing feeds it.
 *
 * So deleting the wire `Instagram -> Slack` flags Slack (nothing feeds it now)
 * while leaving Instagram — which still runs, and simply ends the flow — unmarked.
 *
 * **In-degree is deliberate; it mirrors the engine exactly.** `run-workflow.ts`
 * decides reachability as `incoming.length === 0 || incoming.some(isEdgeActive)`
 * — i.e. a node with no incoming edges is promoted to a ROOT and always runs, and
 * a node that runs activates its outgoing edges. So severing `trigger -> a` in
 * `trigger -> a -> b -> c` leaves `a` a root: a, b and c all still run. Only `a`
 * is mis-wired; b and c are legitimately fed by a. Walking forward from triggers
 * and flagging everything unreached would therefore be WRONG against today's
 * engine — it would mark b and c broken while they demonstrably run.
 *
 * That root-promotion is itself a bug (deleting an edge doesn't stop the node
 * running) — see `plans/bugs/engine-runs-disconnected-nodes.md`. Until it's
 * fixed, these messages must describe WIRING, never runtime: claiming "it will
 * never run" would be the opposite of what the engine does.
 *
 * `triggerNodeTypeSet` (`@/config/node-options`) is reused as the single source
 * of truth for "is this a trigger", the same set draw-time connection validation
 * uses, so the two can't drift. A trigger is a root by design, so it is exempt
 * from the incoming check — no incoming edge is healthy for a trigger. Pure and
 * store-shape-agnostic, so it unit-tests cleanly and works off either the React
 * Flow store or a persisted graph.
 */
export function unrunnableNodes(
  nodes: ConnNode[],
  edges: ConnEdge[],
): Record<string, string> {
  const hasOutgoing = new Set<string>();
  const hasIncoming = new Set<string>();
  for (const edge of edges) {
    hasOutgoing.add(edge.source);
    hasIncoming.add(edge.target);
  }

  const reasons: Record<string, string> = {};
  for (const node of nodes) {
    if (!node.type || node.type === NodeType.INITIAL) continue;

    // A trigger is a root by design: having no incoming edge is healthy for it,
    // so it's only broken when it drives nothing.
    if (triggerNodeTypeSet.has(node.type as NodeType)) {
      if (!hasOutgoing.has(node.id)) {
        reasons[node.id] =
          "This trigger isn't connected to anything — it won't drive any steps";
      }
      continue;
    }

    if (!hasIncoming.has(node.id)) {
      reasons[node.id] =
        "Nothing connects into this node — it isn't wired into the flow";
    }
  }
  return reasons;
}
