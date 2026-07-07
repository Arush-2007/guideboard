import type { Connection, Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import {
  invalidConnectionReason,
  wouldCreateCycle,
} from "./connection-validation";

const edge = (source: string, target: string): Edge => ({
  id: `${source}->${target}`,
  source,
  target,
});

const node = (id: string, type: NodeType): Node => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: {},
});

describe("wouldCreateCycle", () => {
  it("is false when there are no edges", () => {
    expect(wouldCreateCycle("a", "b", [])).toBe(false);
  });

  it("detects a direct back-edge (A->B already exists, adding B->A)", () => {
    expect(wouldCreateCycle("b", "a", [edge("a", "b")])).toBe(true);
  });

  it("detects a cycle across a longer chain (A->B->C, adding C->A)", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(wouldCreateCycle("c", "a", edges)).toBe(true);
  });

  it("allows a forward edge into an independent branch", () => {
    // a->b, a->c ; connecting b->c walks forward from c and never reaches b.
    const edges = [edge("a", "b"), edge("a", "c")];
    expect(wouldCreateCycle("b", "c", edges)).toBe(false);
  });

  it("terminates when the existing graph already contains a cycle", () => {
    // b<->c loop; asking about a->d must not hang.
    const edges = [edge("b", "c"), edge("c", "b")];
    expect(wouldCreateCycle("a", "d", edges)).toBe(false);
  });
});

describe("invalidConnectionReason", () => {
  const nodes = [
    node("trigger", NodeType.MANUAL_TRIGGER),
    node("http", NodeType.HTTP_REQUEST),
    node("slack", NodeType.SLACK),
  ];

  const conn = (source: string, target: string): Connection => ({
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
  });

  it("rejects a self-loop", () => {
    expect(invalidConnectionReason(conn("http", "http"), nodes, [])).toMatch(
      /itself/,
    );
  });

  it("rejects an edge whose target is a trigger", () => {
    expect(invalidConnectionReason(conn("http", "trigger"), nodes, [])).toMatch(
      /trigger/i,
    );
  });

  it("rejects an edge that would create a loop", () => {
    const edges = [edge("http", "slack")];
    expect(
      invalidConnectionReason(conn("slack", "http"), nodes, edges),
    ).toMatch(/loop/);
  });

  it("allows a valid forward edge", () => {
    expect(
      invalidConnectionReason(conn("trigger", "http"), nodes, []),
    ).toBeNull();
  });

  it("rejects a connection missing an endpoint", () => {
    expect(invalidConnectionReason(conn("http", ""), nodes, [])).not.toBeNull();
  });
});
