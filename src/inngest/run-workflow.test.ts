import { describe, expect, it, vi } from "vitest";
import {
  fanOut,
  isFanOut,
  isRouted,
  routed,
  type WorkflowContext,
} from "@/features/executions/types";

// Fake executor registry: each node's behavior is driven by its `data`.
// - `data.route` (string[]) => a branching node that activates those outputs.
// - `data.fanOut` (unknown[]) => a fan-out node that returns those items (and
//   writes its own summary output under `<nodeId>` first).
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
      sortedNodes: [node("a"), node("b"), node("c")],
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
        node("trigger"),
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
        node("cond", { route: ["true"] }),
        node("no"),
        node("after-no"),
      ],
      connections: [edge("cond", "no", "false"), edge("no", "after-no")],
      userId: "u",
      executionId: "exec_test",
      step,
      publish,
      recorder,
    });
    expect(ran).toEqual(["cond"]);
    expect(skipped).toEqual(expect.arrayContaining(["no", "after-no"]));
  });

  it("runs a merge node reached by either branch (OR-join)", async () => {
    const { recorder, ran } = collect();
    await runWorkflowNodes({
      sortedNodes: [
        node("cond", { route: ["true"] }),
        node("yes"),
        node("merge"),
      ],
      connections: [
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
        node("trigger"),
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
        sortedNodes: [node("fan", { fanOut: [{ x: 1 }] })],
        connections: [],
        userId: "u",
        executionId: "exec_test",
        step,
        publish,
        recorder,
      }),
    ).rejects.toThrow(/fanOutDispatcher/);

    expect(failed).toEqual(["fan"]);
    // The node never reaches a SUCCESS record.
    expect(succeeded).toEqual([]);
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
        sortedNodes: [node("fan", { fanOut: [{ x: 1 }] })],
        connections: [],
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
    expect(succeeded).toEqual([]);
  });

  it("still dispatches (empty items) and records SUCCESS when fanning out zero items", async () => {
    const { recorder, ran, skipped } = collect();
    const { dispatcher, calls } = collectDispatcher();

    await runWorkflowNodes({
      sortedNodes: [node("fan", { fanOut: [] }), node("child")],
      connections: [edge("fan", "child")],
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

    expect(ran).toEqual(["fan"]);
    expect(skipped).toEqual(["child"]);
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
