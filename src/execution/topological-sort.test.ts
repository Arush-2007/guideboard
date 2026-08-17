import { describe, expect, it } from "vitest";
import type { Connection, Node } from "@/generated/prisma";
import { topologicalSort } from "./topological-sort";

// Minimal Node/Connection factories — topologicalSort only reads `id`.
const node = (id: string): Node => ({ id }) as unknown as Node;
const edge = (fromNodeId: string, toNodeId: string): Connection =>
  ({ fromNodeId, toNodeId }) as unknown as Connection;

describe("topologicalSort", () => {
  it("returns nodes as-is when there are no connections", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const sorted = topologicalSort(nodes, []);
    expect(sorted.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts a linear chain in dependency order", () => {
    const nodes = [node("c"), node("a"), node("b")];
    const connections = [edge("a", "b"), edge("b", "c")];
    const sorted = topologicalSort(nodes, connections);
    expect(sorted.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("places a parent before both of its branches in a DAG", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const connections = [edge("a", "b"), edge("a", "c")];
    const ids = topologicalSort(nodes, connections).map((n) => n.id);
    expect(ids[0]).toBe("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });

  it("includes orphan nodes that have no connections", () => {
    const nodes = [node("a"), node("b"), node("orphan")];
    const connections = [edge("a", "b")];
    const ids = topologicalSort(nodes, connections).map((n) => n.id);
    expect(ids).toContain("orphan");
    expect(ids).toHaveLength(3);
  });

  it("throws on a cycle", () => {
    const nodes = [node("a"), node("b")];
    const connections = [edge("a", "b"), edge("b", "a")];
    expect(() => topologicalSort(nodes, connections)).toThrow(
      "Workflow contains a cycle",
    );
  });
});
