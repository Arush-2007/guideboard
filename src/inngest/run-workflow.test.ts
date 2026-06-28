import { describe, expect, it, vi } from "vitest";
import { routed, type WorkflowContext } from "@/features/executions/types";

// Fake executor registry: each node's behavior is driven by its `data`.
// - `data.route` (string[]) => a branching node that activates those outputs.
// - otherwise => a non-branching node that adds a `<nodeId>: true` marker key.
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
      step,
      publish,
      recorder,
    });
    // merge's "false" incoming is dead, but its incoming from the live "yes"
    // path keeps it reachable.
    expect(ran).toContain("merge");
  });
});
