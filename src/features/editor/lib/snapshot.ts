import type { Edge, Node } from "@xyflow/react";

/**
 * A normalized, comparison-safe view of the canvas. Keeps only the fields that
 * get persisted and that a user can meaningfully change — everything React Flow
 * layers on at runtime (selection, drag flags, measured sizes, absolute
 * positions) is stripped so that selecting or measuring a node never reads as an
 * edit.
 */
type EditorSnapshot = {
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
};

type NormalizedNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  data: unknown;
};

type NormalizedEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
};

// Positions are compared rounded to the canvas snap grid so that sub-pixel
// jitter (or a drag that lands back in the same cell) is not a change.
const SNAP_GRID = 10;
const snap = (value: number) => Math.round(value / SNAP_GRID) * SNAP_GRID;

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Whitelist the fields that matter and sort by id so two canvases with the same
 * content but different array order / volatile fields normalize identically.
 */
const normalizeSnapshot = (nodes: Node[], edges: Edge[]): EditorSnapshot => ({
  nodes: nodes
    .map((node) => ({
      id: node.id,
      type: node.type ?? "",
      x: snap(node.position?.x ?? 0),
      y: snap(node.position?.y ?? 0),
      data: node.data ?? {},
    }))
    .sort(byId),
  edges: edges
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    }))
    .sort(byId),
});

/**
 * Deterministic serialization with recursively sorted object keys, so that two
 * structurally-equal `data` objects that differ only in key insertion order
 * serialize identically.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};

/**
 * A frozen, comparison-ready serialization of the canvas — the single dirty-
 * tracking primitive. Because it is a plain string it can never alias, and so
 * can never be silently mutated by, the live node objects. (Some config dialogs
 * mutate `node.data` in place; storing the baseline as an object that referenced
 * that same `data` made every edit invisible to the comparison.) Two canvases
 * are equal iff their serializations are `===`.
 */
export const serializeSnapshot = (nodes: Node[], edges: Edge[]): string =>
  canonical(normalizeSnapshot(nodes, edges));
