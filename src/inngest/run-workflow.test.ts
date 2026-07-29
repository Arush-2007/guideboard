import { describe, expect, it, vi } from "vitest";
import {
  fanOut,
  isFanOut,
  isRouted,
  routed,
  type WorkflowContext,
} from "@/features/executions/types";
import { getOutputKeyForNode } from "@/lib/node-ref";

// Fake executor registry: each node's behavior is driven by its `data`.
// - `data.route` (string[]) => a branching node that activates those outputs.
// - `data.fanOut` (unknown[]) => a fan-out node that returns those items (and
//   writes its own summary output under `<nodeId>` first).
// - `data.rewriteSeed` => a fan-out CHILD run's node: it overwrites its own
//   already-seeded key with its per-item output (keeping the marker, like the
//   Sheets find_rows child short-circuit does).
// - otherwise => a non-branching node that adds a `<nodeId>: true` marker key.
vi.mock("@/features/executions/lib/executor-registry", () => ({
  getExecutor:
    () =>
    async ({
      data,
      nodeId,
      outputKey,
      context,
    }: {
      data: Record<string, unknown>;
      nodeId: string;
      outputKey: string;
      context: WorkflowContext;
    }) => {
      if (Array.isArray(data?.route)) {
        return routed(context, data.route as string[]);
      }
      if (Array.isArray(data?.fanOut)) {
        const items = data.fanOut as unknown[];
        // The node writes its own summary output (under its outputKey) before
        // fanning out.
        return fanOut(
          { ...context, [outputKey]: { fannedOut: items.length } },
          items,
        );
      }
      if (data?.rewriteSeed) {
        return {
          ...context,
          [outputKey]: { rewritten: true, __fanOut: true },
        };
      }
      return { ...context, [nodeId]: true };
    },
}));

const { runWorkflowNodes } = await import("./run-workflow");

const step = { run: async (_n: string, fn: () => unknown) => fn() } as any;
const publish = (async () => {}) as any;

type N = { id: string; type: any; name: string; data: unknown };
const node = (id: string, data?: unknown): N => ({
  id,
  type: "AI_TEXT",
  name: id,
  data,
});
// A real trigger type — the ONLY kind the engine runs as a root. Every graph
// below needs one at its head: an action with no incoming edge is skipped, not
// run. (These tests used to root on `node()`, i.e. an AI_TEXT action, which only
// worked because the engine used to promote any node with no incoming edges to a
// root — the bug fixed in run-workflow.ts's reachability gate.)
const trigger = (id: string, data?: unknown): N => ({
  id,
  type: "MANUAL_TRIGGER",
  name: id,
  data,
});
const edge = (from: string, to: string, fromOutput = "main") => ({
  fromNodeId: from,
  toNodeId: to,
  fromOutput,
  toInput: "main",
});

const collect = () => {
  const ran: string[] = [];
  const skipped: string[] = [];
  return {
    recorder: {
      record: async (r: { nodeId: string; status: string }) => {
        if (r.status === "SKIPPED") skipped.push(r.nodeId);
        else ran.push(r.nodeId);
      },
    },
    ran,
    skipped,
  };
};

describe("runWorkflowNodes branch routing", () => {
  it("runs every node when there is no branching (back-compat)", async () => {
    const { recorder, ran, skipped } = collect();
    await runWorkflowNodes({
      sortedNodes: [trigger("a"), node("b"), node("c")],
      connections: [edge("a", "b"), edge("b", "c")],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual(["a", "b", "c"]);
    expect(skipped).toEqual([]);
  });

  it("follows only the taken branch and skips the other", async () => {
    const { recorder, ran, skipped } = collect();
    await runWorkflowNodes({
      sortedNodes: [
        trigger("trigger"),
        node("cond", { route: ["true"] }),
        node("yes"),
        node("no"),
      ],
      connections: [
        edge("trigger", "cond"),
        edge("cond", "yes", "true"),
        edge("cond", "no", "false"),
      ],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toContain("yes");
    expect(skipped).toContain("no");
  });

  it("skips everything downstream of a skipped node", async () => {
    const { recorder, ran, skipped } = collect();
    await runWorkflowNodes({
      sortedNodes: [
        trigger("t"),
        node("cond", { route: ["true"] }),
        node("no"),
        node("after-no"),
      ],
      connections: [
        edge("t", "cond"),
        edge("cond", "no", "false"),
        edge("no", "after-no"),
      ],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual(["t", "cond"]);
    expect(skipped).toEqual(expect.arrayContaining(["no", "after-no"]));
  });

  it("runs a merge node reached by either branch (OR-join)", async () => {
    const { recorder, ran } = collect();
    await runWorkflowNodes({
      sortedNodes: [
        trigger("t"),
        node("cond", { route: ["true"] }),
        node("yes"),
        node("merge"),
      ],
      connections: [
        edge("t", "cond"),
        edge("cond", "yes", "true"),
        edge("cond", "merge", "false"),
        edge("yes", "merge"),
      ],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    // merge's "false" incoming is dead, but its incoming from the live "yes"
    // path keeps it reachable.
    expect(ran).toContain("merge");
  });
});

describe("runWorkflowNodes reachability (only triggers are roots)", () => {
  it("SKIPS an action whose only incoming edge was deleted", async () => {
    // The Instagram case: trigger -> ig -> slack, then ig->slack is removed.
    // Slack must NOT fire. Before the fix it was promoted to a root and ran, so
    // deleting a wire didn't stop anything.
    const { recorder, ran, skipped } = collect();
    await runWorkflowNodes({
      sortedNodes: [trigger("t"), node("ig"), node("slack")],
      connections: [edge("t", "ig")],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual(["t", "ig"]);
    expect(skipped).toEqual(["slack"]);
  });

  it("SKIPS an entire chain severed from its trigger", async () => {
    // a -> b -> c with the trigger wired to nothing: the whole chain is dead.
    // Before the fix `a` became a root and dragged b and c along with it.
    const { recorder, ran, skipped } = collect();
    await runWorkflowNodes({
      sortedNodes: [node("a"), node("b"), node("c"), trigger("t")],
      connections: [edge("a", "b"), edge("b", "c")],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual(["t"]);
    expect(skipped).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("still runs a terminal node (no downstream) — must not regress", async () => {
    const { recorder, ran, skipped } = collect();
    await runWorkflowNodes({
      sortedNodes: [trigger("t"), node("slack")],
      connections: [edge("t", "slack")],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual(["t", "slack"]);
    expect(skipped).toEqual([]);
  });

  it("runs a trigger even though it has no incoming edge", async () => {
    const { recorder, ran } = collect();
    await runWorkflowNodes({
      sortedNodes: [trigger("t")],
      connections: [],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual(["t"]);
  });

  it("runs every trigger when a workflow has more than one", async () => {
    const { recorder, ran } = collect();
    await runWorkflowNodes({
      sortedNodes: [trigger("t1"), trigger("t2"), node("a")],
      connections: [edge("t1", "a")],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual(expect.arrayContaining(["t1", "t2", "a"]));
  });

  it("runs nothing but leaves no orphan running when there is no trigger at all", async () => {
    const { recorder, ran, skipped } = collect();
    await runWorkflowNodes({
      sortedNodes: [node("a"), node("b")],
      connections: [edge("a", "b")],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual([]);
    expect(skipped).toEqual(["a", "b"]);
  });

  it("forces the replayed node to run even though its incoming source is skipped", async () => {
    // Replay-from-node (also how fan-out children are dispatched): the trigger
    // is outside the slice and must not re-fire, the replayed node is a forced
    // root, and its descendants activate normally.
    const { recorder, ran, skipped } = collect();
    await runWorkflowNodes({
      sortedNodes: [trigger("t"), node("a"), node("b")],
      connections: [edge("t", "a"), edge("a", "b")],
      replayFromNodeId: "a",
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual(["a", "b"]);
    expect(skipped).toEqual(["t"]);
  });
});

// A dispatcher spy that records every dispatch call and can be made to reject.
const collectDispatcher = (opts?: { reject?: boolean }) => {
  const calls: {
    nodeId: string;
    outputKey: string;
    context: WorkflowContext;
    items: unknown[];
  }[] = [];
  return {
    dispatcher: {
      dispatch: async (args: {
        nodeId: string;
        outputKey: string;
        context: WorkflowContext;
        items: unknown[];
      }) => {
        calls.push(args);
        if (opts?.reject) throw new Error("dispatch boom");
      },
    },
    calls,
  };
};

describe("runWorkflowNodes fan-out", () => {
  it("dispatches once, skips downstream, and resolves with the node's context", async () => {
    const { recorder, ran, skipped } = collect();
    const { dispatcher, calls } = collectDispatcher();

    const result = await runWorkflowNodes({
      sortedNodes: [
        trigger("trigger"),
        node("fan", { fanOut: [{ x: 1 }, { x: 2 }] }),
        node("child"),
      ],
      connections: [edge("trigger", "fan"), edge("fan", "child")],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
      fanOutDispatcher: dispatcher,
    });

    // Dispatched exactly once with the node id, its resolved output key (the
    // legacy `<type>_<id>` form since the test node has no ref), the node's own
    // output in the context, and the raw items.
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe("fan");
    expect(calls[0].outputKey).toBe("ai_text_fan");
    expect(calls[0].context.ai_text_fan).toEqual({ fannedOut: 2 });
    expect(calls[0].items).toEqual([{ x: 1 }, { x: 2 }]);

    // The fan-out node ran; the downstream connected node did NOT and is SKIPPED.
    expect(ran).toEqual(["trigger", "fan"]);
    expect(skipped).toEqual(["child"]);

    // Run resolves with the fan-out node's context (its own summary output set).
    expect(result.ai_text_fan).toEqual({ fannedOut: 2 });
  });

  it("throws (and records the node FAILED) when no dispatcher is wired in", async () => {
    const failed: string[] = [];
    const succeeded: string[] = [];
    const recorder = {
      record: async (r: { nodeId: string; status: string }) => {
        if (r.status === "FAILED") failed.push(r.nodeId);
        if (r.status === "SUCCESS") succeeded.push(r.nodeId);
      },
    };

    await expect(
      runWorkflowNodes({
        sortedNodes: [trigger("t"), node("fan", { fanOut: [{ x: 1 }] })],
        connections: [edge("t", "fan")],
        userId: "u",
        executionId: "exec_test",
        step,
        publish,
        recorder,
      }),
    ).rejects.toThrow(/fanOutDispatcher/);

    expect(failed).toEqual(["fan"]);
    // The node never reaches a SUCCESS record.
    expect(succeeded).not.toContain("fan");
  });

  it("records the node FAILED and propagates when the dispatcher rejects", async () => {
    const failed: string[] = [];
    const succeeded: string[] = [];
    const recorder = {
      record: async (r: { nodeId: string; status: string }) => {
        if (r.status === "FAILED") failed.push(r.nodeId);
        if (r.status === "SUCCESS") succeeded.push(r.nodeId);
      },
    };
    const { dispatcher } = collectDispatcher({ reject: true });

    await expect(
      runWorkflowNodes({
        sortedNodes: [trigger("t"), node("fan", { fanOut: [{ x: 1 }] })],
        connections: [edge("t", "fan")],
        userId: "u",
        executionId: "exec_test",
        step,
        publish,
        recorder,
        fanOutDispatcher: dispatcher,
      }),
    ).rejects.toThrow("dispatch boom");

    expect(failed).toEqual(["fan"]);
    // Dispatch runs before the SUCCESS record, so the node is never marked done.
    expect(succeeded).not.toContain("fan");
  });

  it("still dispatches (empty items) and records SUCCESS when fanning out zero items", async () => {
    const { recorder, ran, skipped } = collect();
    const { dispatcher, calls } = collectDispatcher();

    await runWorkflowNodes({
      sortedNodes: [trigger("t"), node("fan", { fanOut: [] }), node("child")],
      connections: [edge("t", "fan"), edge("fan", "child")],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
      fanOutDispatcher: dispatcher,
    });

    // 0 children is legal — the dispatcher is still called with empty items.
    expect(calls).toHaveLength(1);
    expect(calls[0].items).toEqual([]);

    expect(ran).toEqual(["t", "fan"]);
    expect(skipped).toEqual(["child"]);
  });
});

describe("fan-out child output recording", () => {
  it("records a node's rewrite of its own seed key, not downstream pass-through", async () => {
    const outputs = new Map<string, unknown>();
    const recorder = {
      record: async (r: {
        nodeId: string;
        status: string;
        output?: unknown;
      }) => {
        if (r.status !== "SKIPPED") outputs.set(r.nodeId, r.output);
      },
    };
    // The engine keys node "a" (type AI_TEXT, no ref) by its legacy output key.
    const key = getOutputKeyForNode("AI_TEXT", "a", null);
    const seed = { item: { x: 1 }, index: 1, total: 2, __fanOut: true };

    await runWorkflowNodes({
      // `a` stays an AI_TEXT so `key` (its legacy output key) still matches; a
      // trigger heads the graph so `a` is reachable.
      sortedNodes: [trigger("t"), node("a", { rewriteSeed: true }), node("b")],
      connections: [edge("t", "a"), edge("a", "b")],
      initialData: { [key]: seed },
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });

    // The rewrite of the pre-seeded key IS node a's output (value-diffed
    // against the seed) …
    expect(outputs.get("a")).toEqual({
      [key]: { rewritten: true, __fanOut: true },
    });
    // … while node b, which only carries the rewritten value through, records
    // nothing for that key.
    expect(outputs.get("b")).toEqual({ b: true });
  });
});

describe("outcome brand cross-checks", () => {
  it("keeps routed and fanOut brands distinct", () => {
    expect(isFanOut(routed({}, ["true"]))).toBe(false);
    expect(isRouted(fanOut({}, [1, 2]))).toBe(false);
    expect(isFanOut(fanOut({}, []))).toBe(true);
    expect(isRouted(routed({}, []))).toBe(true);
  });
});

// ── Step batching ─────────────────────────────────────────────────────────────
// Contiguous inline-safe nodes share ONE Inngest step; a checkpointed node gets
// its own. This is what makes a run fast (a step costs ~4s of dispatch latency
// on Inngest Cloud, dwarfing the work), so the batching has to be both correct
// and actually happening — a regression that quietly stopped batching would
// still pass every test above.
//
// CALCULATOR is inline-safe and AI_TEXT is checkpointed in
// CHECKPOINTED_NODE_TYPES; these tests are written against that classification.
const inline = (id: string, data?: unknown): N => ({
  id,
  type: "CALCULATOR",
  name: id,
  data,
});

/** A step shim that records the ids it is asked to run. */
const recordingStep = () => {
  const ids: string[] = [];
  return {
    ids,
    step: {
      run: async (id: string, fn: () => unknown) => {
        ids.push(id);
        return fn();
      },
    } as any,
  };
};

describe("runWorkflowNodes step batching", () => {
  it("runs a contiguous run of inline-safe nodes in ONE step", async () => {
    const { recorder, ran } = collect();
    const { ids, step: recording } = recordingStep();

    await runWorkflowNodes({
      sortedNodes: [trigger("t"), inline("a"), inline("b"), inline("c")],
      connections: [edge("t", "a"), edge("a", "b"), edge("b", "c")],
      userId: "u",
      executionId: "exec_test",
      step: recording,
      publish,
      recorder,
    });

    // All four nodes, one step. (The mock executors call no steps of their own,
    // so every id here is the engine's.)
    expect(ran).toEqual(["t", "a", "b", "c"]);
    expect(ids).toEqual(["nodes:0-3"]);
  });

  it("never wraps a checkpointed node — its executor's own steps stay real", async () => {
    const { recorder, ran } = collect();
    const { ids, step: recording } = recordingStep();

    await runWorkflowNodes({
      sortedNodes: [trigger("t"), node("ai")],
      connections: [edge("t", "ai")],
      userId: "u",
      executionId: "exec_test",
      step: recording,
      publish,
      recorder,
    });

    expect(ran).toEqual(["t", "ai"]);
    // Only the trigger's segment. Wrapping `ai` would nest its executor's
    // internal step.run calls inside an outer step, which Inngest forbids — and
    // would destroy the read/write memoization those splits exist for.
    expect(ids).toEqual(["nodes:0-0"]);
  });

  it("splits a batch where a checkpointed node interrupts it", async () => {
    const { recorder, ran } = collect();
    const { ids, step: recording } = recordingStep();

    await runWorkflowNodes({
      sortedNodes: [
        trigger("t"),
        inline("a"),
        node("ai"),
        inline("b"),
        inline("c"),
      ],
      connections: [
        edge("t", "a"),
        edge("a", "ai"),
        edge("ai", "b"),
        edge("b", "c"),
      ],
      userId: "u",
      executionId: "exec_test",
      step: recording,
      publish,
      recorder,
    });

    expect(ran).toEqual(["t", "a", "ai", "b", "c"]);
    expect(ids).toEqual(["nodes:0-1", "nodes:3-4"]);
  });

  it("caps a batch so one step can't outgrow the serverless time limit", async () => {
    const { recorder, ran } = collect();
    const { ids, step: recording } = recordingStep();

    // 1 trigger + 29 inline nodes = 30 batchable nodes, past the cap of 25.
    const nodes = [
      trigger("t"),
      ...Array.from({ length: 29 }, (_, i) => inline(`n${i}`)),
    ];
    const connections = nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id));

    await runWorkflowNodes({
      sortedNodes: nodes,
      connections,
      userId: "u",
      executionId: "exec_test",
      step: recording,
      publish,
      recorder,
    });

    expect(ran).toHaveLength(30);
    expect(ids).toEqual(["nodes:0-24", "nodes:25-29"]);
  });

  it("carries a branch decided inside a batch out to a later step", async () => {
    // The routing happens in the middle of a segment and the nodes it gates sit
    // in a LATER one — so the activation has to survive the step boundary, not
    // just the in-memory loop.
    const { recorder, ran, skipped } = collect();

    await runWorkflowNodes({
      sortedNodes: [
        trigger("t"),
        inline("cond", { route: ["true"] }),
        node("yes"),
        node("no"),
      ],
      connections: [
        edge("t", "cond"),
        edge("cond", "yes", "true"),
        edge("cond", "no", "false"),
      ],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });

    expect(ran).toEqual(["t", "cond", "yes"]);
    expect(skipped).toEqual(["no"]);
  });

  it("resumes from a memoized segment without re-running its nodes", async () => {
    // THE failure mode this design has to survive. On a replay Inngest returns a
    // completed step's stored value and never runs its body — so the segment's
    // context and activations exist ONLY in what it returned. An engine that
    // trusted its in-memory closure would resume with an empty context and skip
    // everything downstream, silently.
    const { recorder, ran } = collect();
    const memoized = {
      run: async (id: string, fn: () => unknown) =>
        id === "nodes:0-1"
          ? {
              context: { fromMemo: true },
              activations: [["a", { all: true, outputs: [] }]],
            }
          : fn(),
    } as any;

    const context = await runWorkflowNodes({
      sortedNodes: [trigger("t"), inline("a"), node("after")],
      connections: [edge("t", "a"), edge("a", "after")],
      userId: "u",
      executionId: "exec_test",
      step: memoized,
      publish,
      recorder,
    });

    // The memoized segment's nodes did not re-run …
    expect(ran).toEqual(["after"]);
    // … `after` was still reachable, because the segment's activation for `a`
    // came back with the memoized value …
    expect(context).toHaveProperty("after", true);
    // … and it ran against the stored context, not a fresh empty one.
    expect(context).toHaveProperty("fromMemo", true);
  });
});
