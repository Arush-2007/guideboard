import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import {
  duplicateSelectedNodes,
  selectAllNodes,
  shouldSuppressShortcut,
} from "./node-shortcuts";

const node = (over: Partial<Node> = {}): Node => ({
  id: "n1",
  type: NodeType.MANUAL_TRIGGER,
  position: { x: 100, y: 200 },
  data: {},
  ...over,
});

// A deterministic id generator so assertions don't depend on cuid2 output.
const makeSeq = () => {
  let i = 0;
  return () => `copy-${++i}`;
};

describe("duplicateSelectedNodes", () => {
  it("returns the same array reference when nothing is selected", () => {
    const nodes = [node({ selected: false }), node({ id: "n2" })];
    expect(duplicateSelectedNodes(nodes, makeSeq())).toBe(nodes);
  });

  it("appends one offset, freshly-id'd, selected clone per selected node", () => {
    const nodes = [node({ id: "n1", selected: true })];
    const result = duplicateSelectedNodes(nodes, makeSeq());

    expect(result).toHaveLength(2);
    const clone = result[1];
    expect(clone.id).toBe("copy-1");
    expect(clone.position).toEqual({ x: 140, y: 240 });
    expect(clone.selected).toBe(true);
    expect(clone.type).toBe(NodeType.MANUAL_TRIGGER);
  });

  it("gives a clone its own ref instead of inheriting the original's", () => {
    // AI_TEXT is ref-eligible (MANUAL_TRIGGER is not). `data` is deep-copied, so
    // without a fresh stamp the clone would answer to AI_TEXT_1 too — a
    // duplicate identity on the canvas and a unique-constraint violation on save.
    const nodes = [
      node({
        id: "n1",
        type: NodeType.AI_TEXT,
        selected: true,
        data: { ref: "AI_TEXT_1", prompt: "summarize" },
      }),
    ];
    const result = duplicateSelectedNodes(nodes, makeSeq());

    expect(result[1].data).toEqual({ ref: "AI_TEXT_2", prompt: "summarize" });
    expect(result[0].data).toEqual({ ref: "AI_TEXT_1", prompt: "summarize" });
  });

  it("gives each clone in a multi-selection a distinct ref", () => {
    const nodes = [
      node({
        id: "n1",
        type: NodeType.AI_TEXT,
        selected: true,
        data: { ref: "AI_TEXT_1" },
      }),
      node({
        id: "n2",
        type: NodeType.AI_TEXT,
        selected: true,
        data: { ref: "AI_TEXT_2" },
      }),
    ];
    const result = duplicateSelectedNodes(nodes, makeSeq());

    expect(result[2].data).toEqual({ ref: "AI_TEXT_3" });
    expect(result[3].data).toEqual({ ref: "AI_TEXT_4" });
  });

  it("does not collide with an unselected node's ref", () => {
    const nodes = [
      node({
        id: "n1",
        type: NodeType.AI_TEXT,
        selected: true,
        data: { ref: "AI_TEXT_1" },
      }),
      node({
        id: "n2",
        type: NodeType.AI_TEXT,
        selected: false,
        data: { ref: "AI_TEXT_2" },
      }),
    ];
    const result = duplicateSelectedNodes(nodes, makeSeq());

    expect(result[2].data).toEqual({ ref: "AI_TEXT_3" });
  });

  it("leaves a duplicated trigger ref-less", () => {
    const nodes = [node({ id: "n1", selected: true })];
    const result = duplicateSelectedNodes(nodes, makeSeq());

    expect(result[1].data).toEqual({});
  });

  it("deselects the originals so selection follows the copies", () => {
    const nodes = [
      node({ id: "n1", selected: true }),
      node({ id: "n2", selected: false }),
    ];
    const result = duplicateSelectedNodes(nodes, makeSeq());

    expect(result[0].selected).toBe(false); // original, now deselected
    expect(result[1].selected).toBe(false); // untouched non-selected node
    expect(result[2].selected).toBe(true); // the clone
  });

  it("excludes the INITIAL placeholder from duplication", () => {
    const nodes = [
      node({ id: "init", type: NodeType.INITIAL, selected: true }),
    ];
    expect(duplicateSelectedNodes(nodes, makeSeq())).toBe(nodes);
  });

  it("deep-copies data so mutating a clone can't reach the original", () => {
    const nodes = [
      node({ id: "n1", selected: true, data: { nested: { count: 1 } } }),
    ];
    const result = duplicateSelectedNodes(nodes, makeSeq());
    (result[1].data as { nested: { count: number } }).nested.count = 99;

    expect((nodes[0].data as { nested: { count: number } }).nested.count).toBe(
      1,
    );
  });

  it("duplicates every selected node in a multi-selection", () => {
    const nodes = [
      node({ id: "n1", selected: true }),
      node({ id: "n2", selected: true }),
      node({ id: "n3", selected: false }),
    ];
    const result = duplicateSelectedNodes(nodes, makeSeq());

    expect(result).toHaveLength(5);
    expect(result.slice(3).map((n) => n.id)).toEqual(["copy-1", "copy-2"]);
  });
});

describe("selectAllNodes", () => {
  it("selects every node", () => {
    const nodes = [node({ id: "n1" }), node({ id: "n2", selected: false })];
    const result = selectAllNodes(nodes);
    expect(result.every((n) => n.selected)).toBe(true);
  });

  it("returns the same reference when all are already selected", () => {
    const nodes = [
      node({ selected: true }),
      node({ id: "n2", selected: true }),
    ];
    expect(selectAllNodes(nodes)).toBe(nodes);
  });

  it("returns the same reference for an empty canvas", () => {
    const nodes: Node[] = [];
    expect(selectAllNodes(nodes)).toBe(nodes);
  });

  it("keeps already-selected nodes as the same object", () => {
    const selected = node({ id: "n1", selected: true });
    const nodes = [selected, node({ id: "n2", selected: false })];
    const result = selectAllNodes(nodes);
    expect(result[0]).toBe(selected);
    expect(result[1].selected).toBe(true);
  });
});

describe("shouldSuppressShortcut", () => {
  it("suppresses while typing in form fields", () => {
    expect(shouldSuppressShortcut("INPUT", false, false)).toBe(true);
    expect(shouldSuppressShortcut("TEXTAREA", false, false)).toBe(true);
    expect(shouldSuppressShortcut("SELECT", false, false)).toBe(true);
  });

  it("suppresses on contenteditable and while a dialog is open", () => {
    expect(shouldSuppressShortcut("DIV", true, false)).toBe(true);
    expect(shouldSuppressShortcut("BUTTON", false, true)).toBe(true);
  });

  it("allows shortcuts on the bare canvas", () => {
    expect(shouldSuppressShortcut("DIV", false, false)).toBe(false);
    expect(shouldSuppressShortcut(undefined, false, false)).toBe(false);
  });
});
