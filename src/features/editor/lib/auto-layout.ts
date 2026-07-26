import type { Edge, Node } from "@xyflow/react";
import { NODE_LABEL_MAX_WIDTH, NODE_SIZE, SNAP_GRID } from "./canvas-metrics";

/**
 * Deterministic layered auto-layout for the canvas ("Refine layout").
 *
 * Workflows flow LEFT → RIGHT: every node renders its target handle on
 * `Position.Left` and its source handle on `Position.Right`. So a node's column
 * is its depth in the graph and its row is a free slot in that column, which is
 * the classic layered (Sugiyama-style) arrangement.
 *
 * This is a pure function over positions — no React, no React Flow store, no
 * measurement. That is what makes it unit-testable, and it is why the caller can
 * feed the result straight into editor.tsx's controlled `setNodes`: the history
 * observer records it as ONE undo step and <DirtyTracker> flips the save button,
 * both without any extra wiring.
 */

/**
 * Horizontal distance between column origins: the label's full width plus a
 * 160px gutter.
 *
 * ⚠️ Sized for the LABEL, not the node — see NODE_LABEL_MAX_WIDTH in
 * canvas-metrics.ts for why the label is invisible to measurement. Judge this
 * number by the LABELS, not the node boxes: the label is centred on its node and
 * overhangs it by 60px each side, so the visible gap between two columns is
 * `COLUMN_SPACING - NODE_LABEL_MAX_WIDTH`, not `COLUMN_SPACING - NODE_SIZE`. At
 * 260 the boxes looked 180px apart while the names nearly touched at 60px,
 * which read as cramped.
 */
const COLUMN_SPACING = NODE_LABEL_MAX_WIDTH + 160;

/**
 * Vertical distance between rows: the node box, ~28px of label beneath it, and
 * ~52px of breathing room. Same reasoning as above — the label sits below the
 * node and is invisible to measurement, so the row pitch reserves it explicitly.
 */
const ROW_SPACING = NODE_SIZE + 28 + 52;

/** Blank vertical band between two disconnected subgraphs. */
const COMPONENT_GAP = 120;

/**
 * Passes of the coordinate-refinement loop. Each pass pulls children toward
 * their parents and then parents toward their children; trees (the overwhelming
 * majority of real workflows) converge on the first pass, and a handful more is
 * enough for diamonds/merges. Fixed rather than convergence-tested so the output
 * is deterministic — the same workflow must always refine to the same layout.
 */
const REFINEMENT_PASSES = 4;

const snap = (value: number) => Math.round(value / SNAP_GRID) * SNAP_GRID;

const mean = (values: number[]) =>
  values.reduce((sum, v) => sum + v, 0) / values.length;

type Graph = {
  /** Unique successors, in stable order. */
  children: Map<string, string[]>;
  /** Unique predecessors, in stable order. */
  parents: Map<string, string[]>;
};

/**
 * Adjacency for the layout, with the edge cases that would otherwise corrupt it
 * removed up front: edges pointing at deleted nodes (a stale edge would create a
 * phantom column), self-loops, and duplicate edges — a switch node can legally
 * feed the same target from two outputs, and counting that twice would drag the
 * target's barycenter as if it had two distinct parents.
 */
const buildGraph = (nodeIds: Set<string>, edges: Edge[]): Graph => {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const id of nodeIds) {
    children.set(id, []);
    parents.set(id, []);
  }

  const seen = new Set<string>();
  for (const edge of edges) {
    const { source, target } = edge;
    if (source === target) continue;
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    // NUL separator, so no id containing the delimiter can forge another pair's
    // key. It MUST stay an escape sequence and never a literal control
    // character: a raw 0x00 byte in the source makes git classify this entire
    // file as binary — no diff, no blame, no line-level merge.
    const key = `${source}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    children.get(source)?.push(target);
    parents.get(target)?.push(source);
  }

  return { children, parents };
};

/**
 * Column index per node: the LONGEST path from any root, so a node always sits
 * strictly right of every one of its inputs and edges only ever point forward.
 *
 * Kahn's algorithm, which also gives cycle tolerance for free: anything still
 * unresolved when the queue drains is part of a cycle. The editor's connection
 * validation rejects cycles, but a layout helper must not hang on a workflow
 * that somehow has one (an older row, a direct DB write), so leftovers are
 * placed one column past their deepest resolved input instead of spinning.
 */
const assignLayers = (nodeIds: string[], graph: Graph): Map<string, number> => {
  const layer = new Map<string, number>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) {
    layer.set(id, 0);
    indegree.set(id, graph.parents.get(id)?.length ?? 0);
  }

  const queue = nodeIds.filter((id) => indegree.get(id) === 0);
  const resolved = new Set<string>();
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    resolved.add(id);
    for (const child of graph.children.get(id) ?? []) {
      layer.set(
        child,
        Math.max(layer.get(child) ?? 0, (layer.get(id) ?? 0) + 1),
      );
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }

  for (const id of nodeIds) {
    if (resolved.has(id)) continue;
    const resolvedParents = (graph.parents.get(id) ?? []).filter((p) =>
      resolved.has(p),
    );
    layer.set(
      id,
      resolvedParents.length === 0
        ? 0
        : Math.max(...resolvedParents.map((p) => layer.get(p) ?? 0)) + 1,
    );
  }

  return layer;
};

/**
 * Splits the canvas into connected subgraphs over the UNDIRECTED edges, so an
 * orphan node or a second independent trigger chain gets its own band instead of
 * being interleaved with an unrelated flow.
 */
const findComponents = (nodeIds: string[], graph: Graph): string[][] => {
  const componentOf = new Map<string, number>();
  const components: string[][] = [];

  for (const start of nodeIds) {
    if (componentOf.has(start)) continue;
    const index = components.length;
    const members: string[] = [];
    const stack = [start];
    componentOf.set(start, index);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      members.push(id);
      const neighbours = [
        ...(graph.children.get(id) ?? []),
        ...(graph.parents.get(id) ?? []),
      ];
      for (const next of neighbours) {
        if (componentOf.has(next)) continue;
        componentOf.set(next, index);
        stack.push(next);
      }
    }
    components.push(members);
  }

  return components;
};

/**
 * Row order within each column, seeded by a depth-first walk from the roots.
 * DFS keeps a branch's descendants contiguous, so sibling branches read as
 * separate lanes top-to-bottom instead of interleaving — for the tree-shaped
 * workflows this app produces that alone is a crossing-free order.
 */
const seedOrder = (
  members: string[],
  graph: Graph,
  layer: Map<string, number>,
): Map<number, string[]> => {
  const byLayer = new Map<number, string[]>();
  const placed = new Set<string>();

  const visit = (id: string) => {
    if (placed.has(id)) return;
    placed.add(id);
    const depth = layer.get(id) ?? 0;
    const row = byLayer.get(depth);
    if (row) row.push(id);
    else byLayer.set(depth, [id]);
    for (const child of graph.children.get(id) ?? []) visit(child);
  };

  // Roots first (in the caller's stable order), then anything a root could not
  // reach — a cycle member, or a node whose only edges point backwards.
  for (const id of members) {
    if ((graph.parents.get(id)?.length ?? 0) === 0) visit(id);
  }
  for (const id of members) visit(id);

  return byLayer;
};

/**
 * Places one column's rows at their ideal y while guaranteeing ROW_SPACING
 * between neighbours.
 *
 * Two steps: push down in order until nothing overlaps, then translate the whole
 * column so its centre of mass lands on the centre of mass of the ideals. The
 * translation is uniform, so it cannot reintroduce an overlap, and it is what
 * produces symmetry — three children of one parent get ideals [p, p, p], are
 * pushed to [p, p+160, p+320], then shift up by 160 to land on
 * [p-160, p, p+160]: centred on the parent, which is exactly the "symmetric"
 * result being asked for.
 */
const placeColumn = (
  order: string[],
  ideal: Map<string, number>,
  y: Map<string, number>,
) => {
  const targets = order.map((id) => ideal.get(id) ?? y.get(id) ?? 0);

  const placed: number[] = [];
  for (let i = 0; i < order.length; i++) {
    placed.push(
      i === 0 ? targets[i] : Math.max(targets[i], placed[i - 1] + ROW_SPACING),
    );
  }

  const shift = mean(targets) - mean(placed);
  for (let i = 0; i < order.length; i++) {
    y.set(order[i], placed[i] + shift);
  }
};

/**
 * Lays out one connected subgraph, returning coordinates relative to its own
 * origin (leftmost column at x=0). Vertical placement alternates a downstream
 * pass (pull each node onto the average of its inputs) with an upstream pass
 * (pull each node onto the average of its outputs) so both ends of every edge
 * are straightened rather than only one.
 */
const layoutComponent = (
  members: string[],
  graph: Graph,
  layer: Map<string, number>,
): Map<string, { x: number; y: number }> => {
  const byLayer = seedOrder(members, graph, layer);
  const depths = [...byLayer.keys()].sort((a, b) => a - b);
  const minDepth = depths[0] ?? 0;

  const y = new Map<string, number>();
  for (const depth of depths) {
    (byLayer.get(depth) ?? []).forEach((id, index) => {
      y.set(id, index * ROW_SPACING);
    });
  }

  const averageOf = (ids: string[]) =>
    ids.length === 0
      ? undefined
      : mean(ids.map((id) => y.get(id)).filter((v): v is number => v != null));

  for (let pass = 0; pass < REFINEMENT_PASSES; pass++) {
    for (const depth of depths) {
      const order = byLayer.get(depth) ?? [];
      const ideal = new Map<string, number>();
      for (const id of order) {
        const avg = averageOf(graph.parents.get(id) ?? []);
        if (avg != null) ideal.set(id, avg);
      }
      placeColumn(order, ideal, y);
    }
    for (const depth of [...depths].reverse()) {
      const order = byLayer.get(depth) ?? [];
      const ideal = new Map<string, number>();
      for (const id of order) {
        const avg = averageOf(graph.children.get(id) ?? []);
        if (avg != null) ideal.set(id, avg);
      }
      placeColumn(order, ideal, y);
    }
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const id of members) {
    positions.set(id, {
      x: ((layer.get(id) ?? 0) - minDepth) * COLUMN_SPACING,
      y: y.get(id) ?? 0,
    });
  }
  return positions;
};

/**
 * Ceiling on the aspect stretch. A workflow that is one tall column has almost
 * no width to scale, so an unbounded factor would fling its columns to absurd
 * distances chasing a ratio it can never reach.
 */
const MAX_STRETCH = 4;

/**
 * Widens the layout so the workflow's shape matches the canvas's aspect ratio.
 *
 * WHY: `fitView` scales by `Math.min(xZoom, yZoom)`. A workflow taller than the
 * canvas is height-constrained, so it fills the frame vertically and only ~35%
 * horizontally — nodes crammed into a narrow strip with dead space either side.
 * Uniformly scaling the x axis until the shape matches the canvas's ratio makes
 * both axes bind at once, so the fit fills the frame in BOTH directions.
 *
 * `tallestComponent` is the height of the tallest single subgraph, NOT the
 * height of everything stacked. Those differ whenever the canvas holds
 * disconnected nodes, and using the stacked total would let unrelated orphans
 * drive the real workflow's spacing: four stray nodes would triple the measured
 * height and fling the main flow's columns apart, and deleting one of them would
 * visibly re-space a workflow it isn't part of. The shape being matched is the
 * workflow's, so only a real subgraph gets to define it.
 *
 * Only ever stretches (factor >= 1), never compresses: shrinking could pull
 * columns closer than COLUMN_SPACING and put the names back on top of each
 * other, which is the whole thing this layout exists to prevent. A wide graph
 * (a long chain) is already x-constrained and correctly left alone — its aspect
 * comes from node count, not spacing, so no factor could fix it anyway.
 */
const stretchToAspect = (
  positions: Map<string, { x: number; y: number }>,
  aspectRatio: number,
  tallestComponent: number,
) => {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;

  const xs = [...positions.values()].map((p) => p.x);
  const minX = Math.min(...xs);
  // The SPAN between column origins is what scales; the bounding box is that
  // span plus one node box, because `position` is a node's top-left corner.
  // Scaling the box instead of the span undershoots the target ratio by exactly
  // that node width.
  const span = Math.max(...xs) - minX;
  if (span === 0) return; // a single column has no width to scale
  const height = tallestComponent + NODE_SIZE;

  // Solve `span * factor + NODE_SIZE = aspectRatio * height`.
  const factor = Math.min(
    Math.max((aspectRatio * height - NODE_SIZE) / span, 1),
    MAX_STRETCH,
  );
  if (factor === 1) return;

  for (const [id, point] of positions) {
    positions.set(id, {
      x: snap(minX + (point.x - minX) * factor),
      y: point.y,
    });
  }
};

export type AutoLayoutOptions = {
  /**
   * Canvas width / height. Supply it to have the layout widened so a fit fills
   * the canvas horizontally as well as vertically. Omit it for a purely
   * structural layout — the result is then independent of any viewport, which
   * is what the unit tests rely on.
   */
  aspectRatio?: number;
};

/**
 * Re-positions every node into a clean left-to-right layered layout.
 *
 * Returns a NEW array; nodes whose position is already correct are returned
 * unchanged (same object identity), so a refine that would change nothing
 * produces no history entry and does not mark the workflow dirty. Everything
 * else about a node — data, type, selection — is preserved untouched: this
 * only ever writes `position`.
 */
export const autoLayoutNodes = (
  nodes: Node[],
  edges: Edge[],
  options: AutoLayoutOptions = {},
): Node[] => {
  if (nodes.length === 0) return nodes;

  const nodeIds = new Set(nodes.map((node) => node.id));
  const order = nodes.map((node) => node.id);
  const graph = buildGraph(nodeIds, edges);
  const layer = assignLayers(order, graph);
  const components = findComponents(order, graph);

  const positions = new Map<string, { x: number; y: number }>();
  let cursor = 0;
  let tallestComponent = 0;
  for (const members of components) {
    const local = layoutComponent(members, graph, layer);
    const ys = [...local.values()].map((p) => p.y);
    const top = Math.min(...ys);
    const height = Math.max(...ys) - top;
    tallestComponent = Math.max(tallestComponent, height);
    for (const [id, point] of local) {
      positions.set(id, { x: snap(point.x), y: snap(point.y - top + cursor) });
    }
    cursor += height + ROW_SPACING + COMPONENT_GAP;
  }

  // After every component is placed, so the x span covers the whole canvas —
  // but shaped against the TALLEST SUBGRAPH's height rather than the stacked
  // total, so disconnected orphans can't drive the real workflow's spacing.
  if (options.aspectRatio != null) {
    stretchToAspect(positions, options.aspectRatio, tallestComponent);
  }

  return nodes.map((node) => {
    const next = positions.get(node.id);
    if (!next) return node;
    if (node.position.x === next.x && node.position.y === next.y) return node;
    return { ...node, position: next };
  });
};

/**
 * True when an `autoLayoutNodes` result actually moved something.
 *
 * Relies on the identity-preservation contract above: an unmoved node comes back
 * as the very same object. Takes the already-computed result rather than
 * recomputing the layout, so the caller pays for it once.
 */
export const layoutChanged = (before: Node[], after: Node[]): boolean =>
  after.some((node, index) => node !== before[index]);
