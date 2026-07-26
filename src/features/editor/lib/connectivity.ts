import { TRIGGER_NODE_TYPES } from "@/config/node-kinds";
import { NodeType } from "@/generated/prisma";

type ConnNode = { id: string; type?: string | null };
type ConnEdge = { source: string; target: string };

/**
 * Map of nodeId -> why that node can never run as currently wired. Present ONLY
 * for broken nodes; a node absent from the map is fine.
 *
 * **Mirrors the engine exactly.** `run-workflow.ts` runs a node only if it is a
 * TRIGGER (the only roots) or has a live incoming edge — so the nodes that can
 * never run are exactly those not forward-reachable from some trigger. This
 * flags:
 *
 *  - a **trigger with no outgoing edge** — it fires, but drives nothing; and
 *  - any **non-trigger not reachable from a trigger** — the engine records it
 *    SKIPPED.
 *
 * A node with no *outgoing* edge is perfectly legal — it's the last step of the
 * workflow (a final Slack notify) — and is never flagged; warning on it would
 * nag on every well-formed workflow forever.
 *
 * Reachability is **transitive**, deliberately: severing `trigger -> a` in
 * `trigger -> a -> b -> c` kills a, b *and* c, so all three are flagged. (While
 * the engine still promoted any node with no incoming edges to a root, a, b and
 * c all really did run and only `a` was mis-wired — so this used to be a plain
 * in-degree check. Fixing the engine is what made reachability the correct rule;
 * the two must be changed together or the canvas lies.)
 *
 * `TRIGGER_NODE_TYPES` is the very set the engine roots on, so the canvas and
 * the engine cannot disagree about what runs. Iterative stack + visited set —
 * mirroring `wouldCreateCycle` in `connection-validation.ts` — so a graph that
 * already contains a cycle can't hang this. Pure and store-shape-agnostic, so it
 * unit-tests cleanly and works off either the React Flow store or a persisted
 * graph.
 */
export function unrunnableNodes(
  nodes: ConnNode[],
  edges: ConnEdge[],
): Record<string, string> {
  // The INITIAL placeholder is canvas scaffolding, not part of the graph.
  const real = nodes.filter(
    (node) => node.type && node.type !== NodeType.INITIAL,
  );
  const isTrigger = (node: ConnNode) =>
    TRIGGER_NODE_TYPES.has(node.type as NodeType);

  const outgoing = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source);
    if (list) list.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
    hasIncoming.add(edge.target);
  }

  // Walk forward from every trigger — the engine's only roots. Whatever this
  // walk can't touch is never reached by a live edge, so it never runs.
  const reachable = new Set<string>();
  const stack = real.filter(isTrigger).map((node) => node.id);
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (reachable.has(current)) continue;
    reachable.add(current);
    const next = outgoing.get(current);
    if (next) stack.push(...next);
  }

  const reasons: Record<string, string> = {};
  for (const node of real) {
    // A trigger is a root by design: no incoming edge is healthy for it, so it
    // is only broken when it drives nothing.
    if (isTrigger(node)) {
      if (!outgoing.has(node.id)) {
        reasons[node.id] =
          "This trigger isn't connected to anything — it won't drive any steps";
      }
      continue;
    }

    if (reachable.has(node.id)) continue;

    reasons[node.id] = hasIncoming.has(node.id)
      ? "This node can't be reached from a trigger — it will never run"
      : "Nothing connects into this node — it will never run";
  }
  return reasons;
}
