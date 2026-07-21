import { describe, expect, it } from "vitest";
import type { Connection, Node } from "@/generated/prisma";
import { scopedIdempotencyKey, topologicalSort } from "./utils";

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

describe("scopedIdempotencyKey", () => {
  it("keeps two workflows watching the same source from starving each other", () => {
    // The exact shape that broke a copied workflow: both poll the same sheet
    // row / inbox message, so both mint the SAME external key. Unscoped, the
    // second run is swallowed by the globally-unique Execution.idempotencyKey.
    const externalKey = "google_sheets:sheet-1:7:added";
    expect(scopedIdempotencyKey("wf_original", externalKey)).not.toBe(
      scopedIdempotencyKey("wf_copy", externalKey),
    );
  });

  it("still dedupes a repeat of the same event within one workflow", () => {
    expect(scopedIdempotencyKey("wf_1", "gmail:msg_9")).toBe(
      scopedIdempotencyKey("wf_1", "gmail:msg_9"),
    );
  });

  it("keeps the caller's key intact after the scope prefix", () => {
    // The fan-out lineage badge parses the trailing portion, so the original
    // key has to survive verbatim. (Ambiguity between the two `:` segments is
    // impossible in practice: workflow ids are cuids — lowercase alphanumeric.)
    expect(scopedIdempotencyKey("wf_1", "fanout:exec_a:node_x:3")).toBe(
      "wf:wf_1:fanout:exec_a:node_x:3",
    );
  });
});
