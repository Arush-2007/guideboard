import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import {
  assertNoEdgeIntoTrigger,
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
