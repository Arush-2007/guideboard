import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { autoLayoutNodes, layoutChanged } from "./auto-layout";

const node = (id: string, x = 0, y = 0): Node => ({
  id,
  type: "AI_TEXT",
  position: { x, y },
  data: { label: id },
});

const edge = (source: string, target: string): Edge => ({
  id: `${source}->${target}`,
  source,
  target,
});

const at = (nodes: Node[], id: string) => {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found.position;
};

// Restated here rather than imported: these pin the layout's actual output, so
// a change to the spacing constants should fail these tests and be reviewed,
// not silently ride along.
const COLUMN_SPACING = 360;
const ROW_SPACING = 160;

describe("autoLayoutNodes", () => {
  it("returns an empty canvas untouched", () => {
    const nodes: Node[] = [];
    expect(autoLayoutNodes(nodes, [])).toBe(nodes);
  });

  it("lays a linear chain out in one straight row of even columns", () => {
    const result = autoLayoutNodes(
      [node("a", 40, 900), node("b", -300, 12), node("c", 7, -80)],
      [edge("a", "b"), edge("b", "c")],
    );

    expect(at(result, "a")).toEqual({ x: 0, y: 0 });
    expect(at(result, "b")).toEqual({ x: COLUMN_SPACING, y: 0 });
    expect(at(result, "c")).toEqual({ x: COLUMN_SPACING * 2, y: 0 });
  });

  it("centres a fan-out symmetrically around its parent", () => {
    const result = autoLayoutNodes(
      [node("root"), node("x"), node("y"), node("z")],
      [edge("root", "x"), edge("root", "y"), edge("root", "z")],
    );

    const parent = at(result, "root");
    const children = [at(result, "x"), at(result, "y"), at(result, "z")];

    // All three share a column, one column right of the parent.
    for (const child of children) {
      expect(child.x).toBe(parent.x + COLUMN_SPACING);
    }
    // ...and straddle the parent evenly: the parent sits on their midpoint.
    const ys = children.map((c) => c.y).sort((a, b) => a - b);
    expect(ys).toEqual([
      parent.y - ROW_SPACING,
      parent.y,
      parent.y + ROW_SPACING,
    ]);
  });

  it("re-merges a diamond back onto the branch's centre line", () => {
    const result = autoLayoutNodes(
      [node("a"), node("b"), node("c"), node("d")],
      [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
    );

    // The join sits level with the split it came from, not skewed to one branch.
    expect(at(result, "d").y).toBe(at(result, "a").y);
    expect(at(result, "d").x).toBe(at(result, "a").x + COLUMN_SPACING * 2);
    expect(at(result, "b").y).not.toBe(at(result, "c").y);
  });

  it("puts a node one column right of its DEEPEST input, never overlapping it", () => {
    // a→b→c plus a shortcut a→c: c must clear b's column, not sit on top of it.
    const result = autoLayoutNodes(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    );

    expect(at(result, "b").x).toBe(COLUMN_SPACING);
    expect(at(result, "c").x).toBe(COLUMN_SPACING * 2);
  });

  it("never places two nodes closer than the label footprint allows", () => {
    const nodes = [
      node("t"),
      node("a"),
      node("b"),
      node("c"),
      node("d"),
      node("e"),
    ];
    const result = autoLayoutNodes(nodes, [
      edge("t", "a"),
      edge("t", "b"),
      edge("t", "c"),
      edge("a", "d"),
      edge("a", "e"),
    ]);

    for (const left of result) {
      for (const right of result) {
        if (left.id === right.id) continue;
        const sameColumn = left.position.x === right.position.x;
        if (sameColumn) {
          expect(
            Math.abs(left.position.y - right.position.y),
          ).toBeGreaterThanOrEqual(ROW_SPACING);
        } else {
          expect(
            Math.abs(left.position.x - right.position.x),
          ).toBeGreaterThanOrEqual(COLUMN_SPACING);
        }
      }
    }
  });

  it("stacks disconnected subgraphs into separate bands", () => {
    const result = autoLayoutNodes(
      [node("a1"), node("a2"), node("b1"), node("lonely")],
      [edge("a1", "a2"), edge("b1", "a2")],
    );

    // The orphan shares no band with the connected chain.
    const chainYs = [
      at(result, "a1").y,
      at(result, "a2").y,
      at(result, "b1").y,
    ];
    const orphanY = at(result, "lonely").y;
    for (const y of chainYs) {
      expect(Math.abs(orphanY - y)).toBeGreaterThanOrEqual(ROW_SPACING);
    }
    // Every component is left-aligned to its own origin column.
    expect(at(result, "lonely").x).toBe(0);
    expect(at(result, "a1").x).toBe(0);
    expect(at(result, "b1").x).toBe(0);
  });

  it("snaps every coordinate onto the canvas's 10px grid", () => {
    const result = autoLayoutNodes(
      [node("r"), node("p"), node("q"), node("s"), node("t")],
      [edge("r", "p"), edge("r", "q"), edge("r", "s"), edge("r", "t")],
    );

    for (const n of result) {
      expect(n.position.x % 10).toBe(0);
      expect(n.position.y % 10).toBe(0);
    }
  });

  it("is deterministic — the same workflow always refines identically", () => {
    const nodes = [node("a", 5, 5), node("b", 900, -40), node("c", 12, 700)];
    const edges = [edge("a", "b"), edge("a", "c")];

    expect(autoLayoutNodes(nodes, edges).map((n) => n.position)).toEqual(
      autoLayoutNodes(nodes, edges).map((n) => n.position),
    );
  });

  it("is idempotent — refining an already-refined canvas changes nothing", () => {
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d")];
    const once = autoLayoutNodes(
      [node("a", 33, 91), node("b"), node("c"), node("d")],
      edges,
    );
    const twice = autoLayoutNodes(once, edges);

    // Same objects back, so no history entry and no dirty flag.
    for (const [i, n] of twice.entries()) {
      expect(n).toBe(once[i]);
    }
    expect(layoutChanged(once, twice)).toBe(false);
  });

  it("preserves node identity and data, writing only position", () => {
    const original = node("a", 1, 2);
    original.selected = true;
    const [result] = autoLayoutNodes([original], []);

    expect(result.id).toBe("a");
    expect(result.type).toBe("AI_TEXT");
    expect(result.data).toBe(original.data);
    expect(result.selected).toBe(true);
    expect(original.position).toEqual({ x: 1, y: 2 }); // input not mutated
  });

  it("ignores edges pointing at nodes that no longer exist", () => {
    const result = autoLayoutNodes(
      [node("a"), node("b")],
      [edge("a", "b"), edge("b", "deleted"), edge("ghost", "a")],
    );

    expect(at(result, "a")).toEqual({ x: 0, y: 0 });
    expect(at(result, "b")).toEqual({ x: COLUMN_SPACING, y: 0 });
  });

  it("treats a duplicated edge as a single connection", () => {
    const twice = autoLayoutNodes(
      [node("a"), node("b")],
      [edge("a", "b"), { ...edge("a", "b"), id: "second" }],
    );
    const once = autoLayoutNodes([node("a"), node("b")], [edge("a", "b")]);

    expect(twice.map((n) => n.position)).toEqual(once.map((n) => n.position));
  });

  it("ignores a self-loop instead of pushing the node off its own column", () => {
    const result = autoLayoutNodes([node("a")], [edge("a", "a")]);
    expect(at(result, "a")).toEqual({ x: 0, y: 0 });
  });

  it("terminates on a cyclic graph rather than hanging", () => {
    const result = autoLayoutNodes(
      [node("a"), node("b"), node("c")],
      [edge("a", "b"), edge("b", "c"), edge("c", "a")],
    );

    expect(result).toHaveLength(3);
    for (const n of result) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });
});

describe("autoLayoutNodes — fitting the canvas horizontally", () => {
  /** Bounds as React Flow's `fitView` measures them: node boxes, not labels. */
  const bounds = (nodes: Node[]) => {
    const xs = nodes.map((n) => n.position.x);
    const ys = nodes.map((n) => n.position.y);
    return {
      width: Math.max(...xs) - Math.min(...xs) + 80,
      height: Math.max(...ys) - Math.min(...ys) + 80,
    };
  };

  // A TALL workflow — the shape that actually loses horizontal space: one
  // trigger fanning out to five parallel lanes (notify five channels, say).
  // Five rows against three columns, so height constrains the fit and the
  // canvas is left half empty either side.
  const lanes = ["a", "b", "c", "d", "e"];
  const tallWorkflow = (): [Node[], Edge[]] => [
    [node("t"), ...lanes.flatMap((l) => [node(l), node(`${l}2`)])],
    [...lanes.map((l) => edge("t", l)), ...lanes.map((l) => edge(l, `${l}2`))],
  ];

  it("widens a tall workflow to match the canvas ratio", () => {
    const [nodes, edges] = tallWorkflow();
    const aspectRatio = 1400 / 700; // a typical wide canvas

    const before = bounds(autoLayoutNodes(nodes, edges));
    const after = bounds(autoLayoutNodes(nodes, edges, { aspectRatio }));

    expect(before.width / before.height).toBeLessThan(aspectRatio);
    // Lands on the canvas ratio (within one grid snap), so fitView's
    // min(xZoom, yZoom) binds on both axes at once.
    expect(after.width / after.height).toBeCloseTo(aspectRatio, 1);
    expect(after.height).toBe(before.height); // vertical rhythm untouched
  });

  it("keeps the fit filling ~70% of the canvas on BOTH axes", () => {
    const [nodes, edges] = tallWorkflow();
    const view = { width: 1400, height: 700 };
    const result = bounds(
      autoLayoutNodes(nodes, edges, {
        aspectRatio: view.width / view.height,
      }),
    );

    // Mirrors getViewportForBounds: zoom = min(xZoom, yZoom), where the editor's
    // `padding: 0.15` a side leaves 70% of the viewport for the content.
    const FILL = 0.7;
    const zoom = Math.min(
      (view.width * FILL) / result.width,
      (view.height * FILL) / result.height,
    );
    const horizontalFill = (result.width * zoom) / view.width;

    // Matching the aspect ratio makes the x axis bind too, so the horizontal
    // fill lands on FILL rather than trailing behind the vertical one.
    expect(horizontalFill).toBeGreaterThan(FILL - 0.05);
  });

  it("never compresses a wide workflow back onto its labels", () => {
    // A long chain is already x-constrained; squeezing it to hit a ratio would
    // put the names back on top of each other.
    const nodes = ["a", "b", "c", "d", "e", "f"].map((id) => node(id));
    const edges = [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("d", "e"),
      edge("e", "f"),
    ];

    const plain = autoLayoutNodes(nodes, edges);
    const fitted = autoLayoutNodes(nodes, edges, { aspectRatio: 1400 / 700 });

    expect(fitted.map((n) => n.position)).toEqual(plain.map((n) => n.position));
  });

  it("still honours the minimum column spacing after stretching", () => {
    const [nodes, edges] = tallWorkflow();
    const result = autoLayoutNodes(nodes, edges, { aspectRatio: 1400 / 700 });

    const columns = [...new Set(result.map((n) => n.position.x))].sort(
      (a, b) => a - b,
    );
    for (let i = 1; i < columns.length; i++) {
      expect(columns[i] - columns[i - 1]).toBeGreaterThanOrEqual(
        COLUMN_SPACING,
      );
    }
  });

  it("caps the stretch so a single column cannot fling itself apart", () => {
    // Two columns and twenty rows: almost no width to scale, so an uncapped
    // factor would chase a ratio it can never reach.
    const leaves = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const nodes = [node("r"), ...leaves.map((id) => node(id))];
    const edges = leaves.map((id) => edge("r", id));
    const result = autoLayoutNodes(nodes, edges, { aspectRatio: 1400 / 700 });

    const columns = [...new Set(result.map((n) => n.position.x))].sort(
      (a, b) => a - b,
    );
    expect(columns[1] - columns[0]).toBeLessThanOrEqual(COLUMN_SPACING * 4);
  });

  it("ignores a degenerate canvas measurement", () => {
    const [nodes, edges] = tallWorkflow();
    const plain = autoLayoutNodes(nodes, edges).map((n) => n.position);

    for (const aspectRatio of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        autoLayoutNodes(nodes, edges, { aspectRatio }).map((n) => n.position),
      ).toEqual(plain);
    }
  });

  it("does not let disconnected orphans drive the workflow's spacing", () => {
    // Regression: the stretch used to measure every component stacked together,
    // so unrelated strays inflated the height and flung the real workflow's
    // columns apart — and deleting one would visibly re-space a flow it was
    // never part of.
    const [nodes, edges] = tallWorkflow();
    const opts = { aspectRatio: 1400 / 700 };

    const withoutOrphans = autoLayoutNodes(nodes, edges, opts);
    const withOrphans = autoLayoutNodes(
      [...nodes, node("x1"), node("x2"), node("x3"), node("x4")],
      edges,
      opts,
    );

    const columnsOf = (result: Node[], ids: string[]) =>
      [...new Set(ids.map((id) => at(result, id).x))].sort((a, b) => a - b);

    const ids = nodes.map((n) => n.id);
    expect(columnsOf(withOrphans, ids)).toEqual(columnsOf(withoutOrphans, ids));
  });

  it("stays on the 10px grid after stretching", () => {
    const [nodes, edges] = tallWorkflow();
    const result = autoLayoutNodes(nodes, edges, { aspectRatio: 1600 / 723 });

    for (const n of result) {
      expect(n.position.x % 10).toBe(0);
      expect(n.position.y % 10).toBe(0);
    }
  });

  it("is deterministic for a given canvas ratio", () => {
    const [nodes, edges] = tallWorkflow();
    const opts = { aspectRatio: 1400 / 700 };

    expect(autoLayoutNodes(nodes, edges, opts).map((n) => n.position)).toEqual(
      autoLayoutNodes(nodes, edges, opts).map((n) => n.position),
    );
  });
});

describe("layoutChanged", () => {
  it("reports work done for a scattered canvas", () => {
    const before = [node("a", 17, 400), node("b", 3, 9)];
    const after = autoLayoutNodes(before, [edge("a", "b")]);

    expect(layoutChanged(before, after)).toBe(true);
  });

  it("reports nothing to do for an empty canvas", () => {
    expect(layoutChanged([], autoLayoutNodes([], []))).toBe(false);
  });
});
