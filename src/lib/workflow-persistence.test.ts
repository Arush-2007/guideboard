import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import {
  assertNoEdgeIntoTrigger,
  type GeneratedWorkflow,
  prepareGeneratedNodes,
  validateGeneratedWorkflowGraph,
} from "./workflow-persistence";

const node = (id: string, type: string) => ({
  id,
  type,
  position: { x: 0, y: 0 },
});
const edge = (source: string, target: string) => ({ source, target });

describe("assertNoEdgeIntoTrigger", () => {
  // Triggers are roots — the engine runs them on TYPE, never on in-degree — so
  // an edge into one would fire it on paths that are supposed to be dead. The
  // canvas refuses to draw it; these are the server doors for the same rule.

  it("accepts a normal graph where the trigger only has outgoing edges", () => {
    expect(() =>
      assertNoEdgeIntoTrigger(
        [node("t", "MANUAL_TRIGGER"), node("a", "SLACK")],
        [edge("t", "a")],
      ),
    ).not.toThrow();
  });

  it("rejects an edge pointing into a trigger", () => {
    expect(() =>
      assertNoEdgeIntoTrigger(
        [node("a", "SLACK"), node("t", "MANUAL_TRIGGER")],
        [edge("a", "t")],
      ),
    ).toThrow(/Triggers can't receive a connection/);
  });

  it("rejects with BAD_REQUEST so the UI can render it", () => {
    try {
      assertNoEdgeIntoTrigger(
        [node("a", "SLACK"), node("t", "GMAIL_TRIGGER")],
        [edge("a", "t")],
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe("BAD_REQUEST");
    }
  });

  it("catches a trigger buried among many valid edges", () => {
    expect(() =>
      assertNoEdgeIntoTrigger(
        [
          node("t", "MANUAL_TRIGGER"),
          node("a", "SLACK"),
          node("b", "SLACK"),
          node("t2", "WEBHOOK_TRIGGER"),
        ],
        [edge("t", "a"), edge("a", "b"), edge("b", "t2")],
      ),
    ).toThrow(/Triggers can't receive a connection/);
  });

  it("ignores edges whose target isn't a known node", () => {
    // Endpoint integrity is a separate check; this one must not crash on it.
    expect(() =>
      assertNoEdgeIntoTrigger([node("a", "SLACK")], [edge("a", "ghost")]),
    ).not.toThrow();
  });

  it("ignores nodes with no type", () => {
    expect(() =>
      assertNoEdgeIntoTrigger(
        [
          { id: "a", type: "SLACK" },
          { id: "x", type: null },
        ],
        [edge("a", "x")],
      ),
    ).not.toThrow();
  });

  it("does not treat an action as a trigger", () => {
    expect(() =>
      assertNoEdgeIntoTrigger(
        [node("a", "SLACK"), node("b", "AI_TEXT")],
        [edge("a", "b")],
      ),
    ).not.toThrow();
  });
});

describe("validateGeneratedWorkflowGraph", () => {
  // The AI builders are the only realistic source of a graph the canvas could
  // never draw — this validator is what both of them go through.

  it("rejects a generated workflow with an edge into a trigger", () => {
    expect(() =>
      validateGeneratedWorkflowGraph(
        [node("a", "SLACK"), node("t", "MANUAL_TRIGGER")],
        [edge("a", "t")],
      ),
    ).toThrow(/Triggers can't receive a connection/);
  });

  it("still accepts a well-formed generated workflow", () => {
    expect(() =>
      validateGeneratedWorkflowGraph(
        [node("t", "MANUAL_TRIGGER"), node("a", "SLACK")],
        [edge("t", "a")],
      ),
    ).not.toThrow();
  });

  it("reports unknown endpoints before consulting node types", () => {
    // Order matters: the trigger check reads a target's type, so endpoint
    // integrity has to fail first and with its own message.
    expect(() =>
      validateGeneratedWorkflowGraph(
        [node("t", "MANUAL_TRIGGER")],
        [edge("t", "ghost")],
      ),
    ).toThrow(/unknown node ids/);
  });

  it("still rejects an invalid node type", () => {
    expect(() =>
      validateGeneratedWorkflowGraph([node("a", "NOT_A_NODE")], []),
    ).toThrow(/Invalid node type/);
  });

  it("still rejects duplicate node ids", () => {
    expect(() =>
      validateGeneratedWorkflowGraph(
        [node("a", "SLACK"), node("a", "AI_TEXT")],
        [],
      ),
    ).toThrow(/duplicate node ids/);
  });
});

describe("prepareGeneratedNodes", () => {
  const graph = (
    nodes: GeneratedWorkflow["nodes"],
    edges: GeneratedWorkflow["edges"],
  ): GeneratedWorkflow => ({ name: "Generated", nodes, edges });

  const gen = (
    id: string,
    type: string,
    data: Record<string, unknown> = {},
  ): GeneratedWorkflow["nodes"][number] => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  });
  const link = (source: string, target: string) => ({
    id: `${source}-${target}`,
    source,
    target,
  });

  const messageOf = (
    rows: { id: string; data: Record<string, unknown> }[],
    id: string,
  ) => rows.find((r) => r.id === id)?.data.message;

  it("strips a reference to a step that cannot reach the node holding it", () => {
    // The model wired AI_TEXT as a SIBLING of SLACK, not upstream of it.
    const { rows, danglingRefs } = prepareGeneratedNodes(
      graph(
        [
          gen("n1", "MANUAL_TRIGGER"),
          gen("n2", "AI_TEXT", { prompt: "summarize" }),
          gen("n3", "SLACK", { message: "Result: @<AI_TEXT_1.output>@" }),
        ],
        [link("n1", "n2"), link("n1", "n3")],
      ),
    );

    expect(danglingRefs).toHaveLength(1);
    expect(danglingRefs[0]).toMatchObject({
      nodeId: "n3",
      refs: [{ ref: "AI_TEXT_1", field: "message" }],
    });
    // Only the token goes; the prose the model wrote around it stays.
    expect(messageOf(rows, "n3")).toBe("Result: ");
  });

  it("leaves a correctly wired reference alone", () => {
    const { rows, danglingRefs } = prepareGeneratedNodes(
      graph(
        [
          gen("n1", "MANUAL_TRIGGER"),
          gen("n2", "AI_TEXT", { prompt: "summarize" }),
          gen("n3", "SLACK", { message: "Result: @<AI_TEXT_1.output>@" }),
        ],
        [link("n1", "n2"), link("n2", "n3")],
      ),
    );

    expect(danglingRefs).toEqual([]);
    expect(messageOf(rows, "n3")).toBe("Result: @<AI_TEXT_1.output>@");
  });

  it("checks AFTER rewriting, so a legacy key the model emitted survives", () => {
    // The ordering this function exists to pin down. `ai_text_n2` is the legacy
    // `<type>_<id>` form; it is rewritten to `AI_TEXT_1` first, and only then
    // checked. Checking first would condemn it — no node publishes that key.
    const { rows, danglingRefs } = prepareGeneratedNodes(
      graph(
        [
          gen("n1", "MANUAL_TRIGGER"),
          gen("n2", "AI_TEXT", { prompt: "summarize" }),
          gen("n3", "SLACK", { message: "@<ai_text_n2.output>@" }),
        ],
        [link("n1", "n2"), link("n2", "n3")],
      ),
    );

    expect(danglingRefs).toEqual([]);
    expect(messageOf(rows, "n3")).toBe("@<AI_TEXT_1.output>@");
  });

  it("keeps the ref in the column and out of the persisted blob", () => {
    const { rows } = prepareGeneratedNodes(
      graph([gen("n1", "MANUAL_TRIGGER"), gen("n2", "SLACK")], []),
    );

    const slack = rows.find((r) => r.id === "n2");
    expect(slack?.ref).toBe("SLACK_1");
    // The check needs `data.ref`; the row must not carry it onward.
    expect(slack?.data).not.toHaveProperty("ref");
  });

  it("preserves each node's position through the strip pass", () => {
    const nodes = [
      { ...gen("n1", "MANUAL_TRIGGER"), position: { x: 11, y: 22 } },
      {
        ...gen("n2", "SLACK", { message: "@<GHOST_1.output>@" }),
        position: { x: 333, y: 444 },
      },
    ];
    const { rows } = prepareGeneratedNodes(graph(nodes, [link("n1", "n2")]));

    expect(rows.find((r) => r.id === "n2")?.position).toEqual({
      x: 333,
      y: 444,
    });
  });
});
