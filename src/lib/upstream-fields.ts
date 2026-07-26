import type { Edge } from "@xyflow/react";
import toposort from "toposort";
import { nodeOutputs, resolveOutputPath } from "@/config/node-outputs";
import type { NodeType } from "@/generated/prisma";
import {
  displayNameFor,
  getOutputKeyForNode,
  nodeDisplayName,
  type RefCarrier,
  readNodeRef,
} from "@/lib/node-ref";

/**
 * Pure logic behind the variable picker (`<VariablePicker>`). Kept React-free so
 * it can be unit-tested directly.
 *
 * Two stages, in order: `getUpstreamFields` turns the canvas graph into every
 * field a node can reference — reading the `node-outputs.ts` registry for
 * field-level paths, falling back to the whole-output blob for node types not yet
 * declared there — and `buildPickerSources` folds those into the picker's
 * first-panel list of the NODES they came from.
 */

/**
 * All nodes with a directed edge into `currentNodeId` (transitive) — every
 * upstream node whose output may be in context before this node runs.
 */
export function getUpstreamNodeIds(
  currentNodeId: string,
  edges: Pick<Edge, "source" | "target">[],
): Set<string> {
  const upstream = new Set<string>();

  function visit(id: string) {
    for (const e of edges) {
      if (e.target === id && e.source !== id && !upstream.has(e.source)) {
        upstream.add(e.source);
        visit(e.source);
      }
    }
  }

  visit(currentNodeId);
  return upstream;
}

/**
 * Position of every node in the order the workflow RUNS, so the picker can list
 * upstream nodes the way the canvas reads (trigger first) instead of by cuid.
 *
 * Deliberately not `topologicalSort` from `inngest/utils.ts`: that one imports
 * the Inngest client and takes Prisma rows, so it can neither reach a client
 * bundle nor see canvas edges. Both go through the same `toposort` package, so
 * the ordering itself stays one implementation.
 *
 * Returns an empty map if the graph can't be ordered (a cycle), which drops
 * callers back to a stable id sort — the picker must never throw on a graph the
 * canvas happens to allow.
 */
function runOrderIndex(
  edges: Pick<Edge, "source" | "target">[],
): Map<string, number> {
  // toposort counts a self-edge as a cycle. Dropping them here is a DIVERGENCE
  // from the engine, which passes connections straight through and throws: a
  // self-edge is a real cycle the engine must refuse to run, but the picker
  // still has to offer fields for the rest of a graph that happens to hold one.
  const pairs = edges
    .filter((e) => e.source !== e.target)
    .map((e): [string, string] => [e.source, e.target]);
  if (pairs.length === 0) return new Map();
  try {
    return new Map(toposort(pairs).map((id, index) => [id, index]));
  } catch {
    return new Map();
  }
}

export type UpstreamFieldRow = {
  nodeId: string;
  nodeType: string;
  /**
   * The node's own `ref` (`AI_TEXT_1`), or null for a ref-less trigger. Enough
   * for a caller to name the node via `displayNameFor` — which is why no
   * pre-rendered label is stored alongside it.
   */
  nodeRef: string | null;
  /** Friendly field name, e.g. "Sender first name" (or "Whole output"). */
  fieldLabel: string;
  /** The text inserted into the field, e.g. `@<telegram.from.firstName>@`. */
  insertText: string;
  example?: string;
};

type GraphNode = {
  id: string;
  type?: string | null;
  /**
   * A node's saved config (kept loose so React Flow's `Node[]` is assignable).
   * Read here for the node's `ref` (via `readNodeRef`), and for
   * `discoveredFields` — fields a node learned at config time (e.g. a Google
   * Form's questions via "Load questions"), each carrying the exact `@<path>@`
   * to reference it. This lets a node expose a dynamic, user-defined output
   * schema on top of its static `node-outputs` descriptor, without baking
   * domain-specific fields into the registry.
   */
  data?: Record<string, unknown> | null;
};

type DiscoveredField = { path: string; label: string; example?: string };

/** Safely reads a node's saved `discoveredFields` (untyped `data` blob). */
function readDiscoveredFields(data: GraphNode["data"]): DiscoveredField[] {
  const raw = (data as { discoveredFields?: unknown } | null | undefined)
    ?.discoveredFields;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (f): f is DiscoveredField =>
      !!f && typeof (f as DiscoveredField).path === "string",
  );
}

/**
 * Flattened, ordered list of pickable fields from every node upstream of
 * `currentNodeId`. Declared nodes (in `node-outputs.ts`) expand into individual
 * fields; undeclared nodes contribute a single "whole output" entry.
 */
export function getUpstreamFields(
  currentNodeId: string,
  nodes: GraphNode[],
  edges: Pick<Edge, "source" | "target">[],
): UpstreamFieldRow[] {
  const upstreamIds = getUpstreamNodeIds(currentNodeId, edges);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const rows: UpstreamFieldRow[] = [];

  // Run order, falling back to the id sort for any node the ordering couldn't
  // place (only reachable when the graph is cyclic and the whole index is empty).
  const runOrder = runOrderIndex(edges);
  const ordered = [...upstreamIds].sort((a, b) => {
    const ia = runOrder.get(a);
    const ib = runOrder.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a.localeCompare(b);
  });

  for (const id of ordered) {
    const node = nodeById.get(id);
    if (!node?.type) continue;

    const type = node.type as NodeType;
    // The ref (e.g. "AI_TEXT_1") is the node's identity: it heads the picker's
    // node list AND is the exact token the inserted `@<AI_TEXT_1.output>@`
    // names, so what the user picks here reads the same as what the canvas
    // shows. Carried raw — naming is `displayNameFor`'s job, not this walk's.
    const ref = readNodeRef(node.data);
    const descriptor = nodeOutputs[type];

    if (descriptor) {
      for (const field of descriptor.fields) {
        // Config-dependent fields (e.g. Sheets append vs find_rows) declare a
        // predicate over the node's saved data; hide the ones that don't apply.
        if (field.pickIf && !field.pickIf(node.data)) continue;
        const path = resolveOutputPath(type, id, field.path, ref);
        if (!path) continue;
        rows.push({
          nodeId: id,
          nodeType: String(node.type),
          nodeRef: ref,
          fieldLabel: field.label,
          insertText: `@<${path}>@`,
          example: field.example,
        });
      }
    } else {
      // Node type not declared in the registry yet — offer the whole blob so
      // power users can still drill in manually.
      rows.push({
        nodeId: id,
        nodeType: String(node.type),
        nodeRef: ref,
        fieldLabel: "Whole output",
        insertText: `@<${getOutputKeyForNode(String(node.type), id, ref)}>@`,
      });
    }

    // Append any dynamically discovered fields the node saved (e.g. a Google
    // Form's questions). These carry their own ready-to-insert path, so they
    // layer on top of the static descriptor for the same node.
    for (const field of readDiscoveredFields(node.data)) {
      rows.push({
        nodeId: id,
        nodeType: String(node.type),
        nodeRef: ref,
        fieldLabel: field.label || field.path,
        insertText: `@<${field.path}>@`,
        example: field.example,
      });
    }
  }

  return rows;
}

/** Collapses a label to comparable letters+digits: "Sender first name" → "senderfirstname". */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The upstream field that best matches a target column's name, behind
 * "Auto-map by name".
 *
 * An EXACT normalized match always wins, and only then does a substring match in
 * either direction count. The two passes are not interchangeable: `fields`
 * arrives in run order, so the trigger is always first, and a trigger's verbose
 * label would otherwise beat a later node's exact one on nothing but position — a
 * column named "Name" filling from the Telegram trigger's "Sender first name"
 * (`senderfirstname` contains `name`) instead of the AI node's "Name".
 *
 * Among equally loose matches the earliest — nearest the trigger — still wins;
 * there is nothing better to break that tie on.
 */
export function matchFieldByName<T extends { fieldLabel: string }>(
  targetLabel: string,
  fields: T[],
): T | undefined {
  const target = normalizeLabel(targetLabel);
  return (
    fields.find((f) => normalizeLabel(f.fieldLabel) === target) ??
    fields.find((f) => {
      const label = normalizeLabel(f.fieldLabel);
      return label.includes(target) || target.includes(label);
    })
  );
}

/** One pickable field, as the picker renders it. */
export type PickerFieldRow = { insertText: string; fieldLabel: string };

/**
 * A group of fields the CURRENT node offers about itself, rather than fields
 * inherited from an upstream node — the Sheets insert action's "row above" is
 * the first of these. Listed ahead of the upstream nodes, since they belong to
 * the step the user is configuring.
 */
export type PickerExtraGroup = {
  label: string;
  fields: PickerFieldRow[];
};

/**
 * One entry on the picker's first panel: a place fields come from. Clicking it
 * opens the second panel with just that source's fields.
 */
export type PickerSource = {
  /** Stable identity, so the open panel survives a canvas re-render. */
  key: string;
  /** Row label and second-panel title. */
  label: string;
  /** Muted second line — set only when it says something the label doesn't. */
  sublabel?: string;
  /** Node type whose registry icon fronts the row. */
  nodeType?: string;
} & (
  | { kind: "fields"; fields: PickerFieldRow[] }
  /** The current node's custom features; the picker owns their rendering. */
  | { kind: "custom" }
);

/**
 * Turns the flat field list into the picker's first-panel source list: the
 * current node's own groups first, then every upstream node in run order.
 *
 * Both of the current node's contributions are named after it (`SHEETS_1 -
 * Custom`) so it's obvious they come from the step being configured rather than
 * from an earlier one. Every name here — the current node's and each upstream
 * node's — comes from the one rule in `node-ref.ts`, so a row reads the same as
 * that node's canvas caption and settings-dialog title.
 *
 * Kept here, beside `getUpstreamFields`, so the whole picker model is one
 * React-free unit that can be tested without a DOM.
 */
export function buildPickerSources({
  rows,
  currentNode,
  extraGroups = [],
  hasCustomFeatures = false,
  labelForType,
}: {
  rows: UpstreamFieldRow[];
  currentNode: RefCarrier | null | undefined;
  extraGroups?: PickerExtraGroup[];
  hasCustomFeatures?: boolean;
  labelForType: (nodeType: string) => string | undefined;
}): PickerSource[] {
  const sources: PickerSource[] = [];
  const currentName = nodeDisplayName(currentNode, labelForType);
  const currentType = currentNode?.type ?? undefined;

  if (hasCustomFeatures) {
    sources.push({
      key: "custom",
      label: `${currentName} - Custom`,
      kind: "custom",
      nodeType: currentType,
    });
  }

  extraGroups.forEach((group, index) => {
    sources.push({
      key: `own:${index}`,
      label: `${currentName} - ${group.label}`,
      kind: "fields",
      fields: group.fields,
      nodeType: currentType,
    });
  });

  // `rows` already arrives in run order; grouping preserves first-seen order.
  const byNode = new Map<string, PickerSource & { kind: "fields" }>();
  for (const row of rows) {
    const existing = byNode.get(row.nodeId);
    if (existing) {
      existing.fields.push(row);
      continue;
    }
    const label = displayNameFor(row.nodeRef, row.nodeType, labelForType);
    byNode.set(row.nodeId, {
      key: `node:${row.nodeId}`,
      label,
      // A renamed node shows its type underneath (`AI_TEXT_1` / "AI Text"); a
      // trigger already IS its type label, so a repeat of it adds nothing.
      sublabel: labelForType(row.nodeType) ?? undefined,
      nodeType: row.nodeType,
      kind: "fields",
      fields: [row],
    });
  }
  for (const source of byNode.values()) {
    if (source.sublabel === source.label) source.sublabel = undefined;
    sources.push(source);
  }

  return sources;
}
