import { describe, expect, it, vi } from "vitest";
import { routed, type WorkflowContext } from "@/features/executions/types";

/**
 * Contract test: the canvas's "this node can never run" warning must agree with
 * what the engine actually skips.
 *
 * These are two independent implementations of one question — `unrunnableNodes`
 * (static graph reachability, drives the amber badge) and the reachability gate
 * in `run-workflow.ts` (dynamic edge activation, decides what executes). They
 * share only the `TRIGGER_NODE_TYPES` import, which pins the ROOT set but says
 * nothing about activation. Nothing else stopped them drifting — and they HAVE
 * drifted, expensively: the badge once told users a node "will never run" while
 * the engine cheerfully ran it, because the engine promoted any node with no
 * incoming edges to a root. This file is the guard against a repeat.
 *
 * The two are not equal by definition — the canvas is a static over-
 * approximation, the engine is dynamic — so the invariants are:
 *
 *  1. **Soundness (always).** Everything the canvas flags must be skipped by the
 *     engine, under any routing. If the canvas claims "never runs" and the node
 *     runs, the product lied to a paying user. This is the direction that matters.
 *  2. **Tightness (non-branching graphs only).** With no branch routing, the set
 *     the engine skips is EXACTLY what the canvas flags, minus triggers — a
 *     trigger that drives nothing is flagged on the canvas but still runs.
 *
 * Branching deliberately breaks tightness, not soundness: a node on an untaken
 * branch is skipped at runtime yet must NOT be flagged, since it can run under
 * some other routing. The last test pins exactly that.
 */

// Non-branching by default (returns a plain context => activates ALL outgoing
// edges, like any normal action). `data.route` makes a node branch.
vi.mock("@/features/executions/lib/executor-registry", () => ({
  getExecutor:
    () =>
    async ({
      data,
      nodeId,
      context,
    }: {
      data: Record<string, unknown>;
      nodeId: string;
      context: WorkflowContext;
    }) => {
      if (Array.isArray(data?.route)) {
        return routed(context, data.route as string[]);
      }
      return { ...context, [nodeId]: true };
    },
}));

const { runWorkflowNodes } = await import("./run-workflow");
const { topologicalSort } = await import("./utils");
const { unrunnableNodes } = await import("@/features/editor/lib/connectivity");
const { TRIGGER_NODE_TYPES } = await import("@/config/node-kinds");

const step = { run: async (_n: string, fn: () => unknown) => fn() } as any;
const publish = (async () => {}) as any;

const TRIGGER = "MANUAL_TRIGGER";
const ACTION = "SLACK";

/** One graph definition; the adapters below feed it to both implementations. */
type Graph = {
  nodes: { id: string; type: string; data?: unknown }[];
  edges: { from: string; to: string; fromOutput?: string }[];
};

const n = (id: string, type: string, data?: unknown) => ({ id, type, data });
const e = (from: string, to: string, fromOutput?: string) => ({
  from,
  to,
  fromOutput,
});

/** What the canvas badge sees. */
const canvasFlags = (g: Graph): string[] =>
  Object.keys(
    unrunnableNodes(
      g.nodes.map((node) => ({ id: node.id, type: node.type })),
      g.edges.map((edge) => ({ source: edge.from, target: edge.to })),
    ),
  ).sort();

/** What the engine actually does — through the real topologicalSort, as `executeWorkflow` does. */
const runEngine = async (g: Graph) => {
  const nodes = g.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    name: node.id,
    data: node.data ?? {},
  }));
  const connections = g.edges.map((edge) => ({
    fromNodeId: edge.from,
    toNodeId: edge.to,
    fromOutput: edge.fromOutput ?? "main",
    toInput: "main",
  }));

  const ran: string[] = [];
  const skipped: string[] = [];
  await runWorkflowNodes({
    sortedNodes: topologicalSort(nodes as any, connections as any) as any,
    connections,
    userId: "u",
    executionId: "exec_parity",
    step,
    publish,
    recorder: {
      record: async (r: { nodeId: string; status: string }) => {
        (r.status === "SKIPPED" ? skipped : ran).push(r.nodeId);
      },
    } as any,
  });
  return { ran: ran.sort(), skipped: skipped.sort() };
};

const isTrigger = (g: Graph, id: string) =>
  TRIGGER_NODE_TYPES.has(g.nodes.find((node) => node.id === id)?.type as never);

// Non-branching graphs: canvas and engine must agree exactly.
const GRAPHS: [string, Graph][] = [
  [
    "fully wired chain",
    {
      nodes: [n("t", TRIGGER), n("a", ACTION), n("b", ACTION)],
      edges: [e("t", "a"), e("a", "b")],
    },
  ],
  [
    "the Instagram case: the downstream wire is deleted",
    {
      nodes: [n("t", TRIGGER), n("ig", ACTION), n("slack", ACTION)],
      edges: [e("t", "ig")],
    },
  ],
  [
    "a whole chain severed from its trigger",
    {
      nodes: [n("t", TRIGGER), n("a", ACTION), n("b", ACTION), n("c", ACTION)],
      edges: [e("a", "b"), e("b", "c")],
    },
  ],
  [
    "a fully unwired canvas",
    { nodes: [n("t", TRIGGER), n("a", ACTION)], edges: [] },
  ],
  [
    "no trigger at all",
    { nodes: [n("a", ACTION), n("b", ACTION)], edges: [e("a", "b")] },
  ],
  [
    "a diamond (merge fed by two paths)",
    {
      nodes: [
        n("t", TRIGGER),
        n("x", ACTION),
        n("l", ACTION),
        n("r", ACTION),
        n("m", ACTION),
      ],
      edges: [e("t", "x"), e("x", "l"), e("x", "r"), e("l", "m"), e("r", "m")],
    },
  ],
  [
    "two triggers, one of them wired to nothing",
    {
      nodes: [n("t1", TRIGGER), n("t2", TRIGGER), n("a", ACTION)],
      edges: [e("t1", "a")],
    },
  ],
];

describe("canvas/engine parity — what the badge claims vs what the engine runs", () => {
  it.each(GRAPHS)(
    "%s: the engine skips exactly what the canvas flags (minus triggers)",
    async (_name, g) => {
      const flagged = canvasFlags(g);
      const { skipped, ran } = await runEngine(g);

      // A flagged trigger still RUNS (it just drives nothing), so it is the one
      // thing the canvas flags that the engine does not skip.
      expect(flagged.filter((id) => !isTrigger(g, id))).toEqual(skipped);

      // Soundness, stated directly: nothing the canvas calls dead is executed.
      for (const id of flagged) {
        if (!isTrigger(g, id)) expect(ran).not.toContain(id);
      }
    },
  );

  it("branching breaks tightness but NOT soundness", async () => {
    // `cond` takes only the "true" branch, so `no` is skipped at runtime — yet
    // it must NOT be flagged: it is wired, and runs whenever the branch is taken.
    // `orphan` is the only node that can never run under any routing.
    const g: Graph = {
      nodes: [
        n("t", TRIGGER),
        n("cond", ACTION, { route: ["true"] }),
        n("yes", ACTION),
        n("no", ACTION),
        n("orphan", ACTION),
      ],
      edges: [
        e("t", "cond"),
        e("cond", "yes", "true"),
        e("cond", "no", "false"),
      ],
    };

    const flagged = canvasFlags(g);
    const { ran, skipped } = await runEngine(g);

    // Static analysis flags only the genuinely unreachable node …
    expect(flagged).toEqual(["orphan"]);
    // … while the engine also skips the untaken branch at runtime.
    expect(skipped).toEqual(["no", "orphan"]);
    expect(ran).toEqual(["cond", "t", "yes"]);

    // Soundness holds: canvas-flagged ⊆ engine-skipped.
    for (const id of flagged) expect(skipped).toContain(id);
  });
});
