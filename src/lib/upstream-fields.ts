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
 * Deliberately not `topologicalSort` from `@/execution/topological-sort`: that
 * one takes Prisma rows, so it cannot see canvas edges. It used to also import
 * the Inngest client — the second reason this reimplementation existed, removed
 * when the runtime split moved it out of `inngest/utils.ts` — but the row-vs-edge
 * mismatch remains and is enough on its own. Both go through the same `toposort`
 * package, so the ordering itself stays one implementation.
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
  /** The same reference without its wrapper — see {@link PickerFieldRow}. */
  path: string;
  /**
   * True when the row came from the node's saved `discoveredFields` — a shape
   * read off the LIVE data (a sheet's headers, a form's questions) rather than
   * declared in `node-outputs.ts`.
   *
   * The difference is exhaustiveness, and it is load-bearing for the
   * dangling-reference check: discovered siblings are the complete contents of
   * their parent, so a path alongside them that is missing really is missing.
   * The static registry declares only what is worth OFFERING and routinely omits
   * outputs the executor emits (Sheets `find_rows` publishes `rows`, which no
   * descriptor mentions), so absence there proves nothing.
   */
  discovered?: boolean;
  example?: string;
};

export type GraphNode = {
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
 * Everything ONE node offers, as pickable rows — the unit `getUpstreamFields`
 * is assembled from.
 *
 * Split out because two callers need "what does this node publish?" and only one
 * of them is walking a single node's ancestry. The dangling-reference validator
 * (`lib/dangling-refs.ts`) answers that question for EVERY node on every canvas
 * change; going through `getUpstreamFields` per node would re-run the graph's
 * toposort once per node, on every drag frame, to rebuild rows that don't depend
 * on the walk at all. Extracting it also keeps a node's output contract stated
 * once, so the picker and the validator can never disagree about what a node
 * publishes.
 */
export function fieldsForNode(node: GraphNode): UpstreamFieldRow[] {
  if (!node.type) return [];

  const rows: UpstreamFieldRow[] = [];
  const id = node.id;
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
        path,
        insertText: `@<${path}>@`,
        example: field.example,
      });
    }
  } else {
    // Node type not declared in the registry yet — offer the whole blob so
    // power users can still drill in manually.
    const path = getOutputKeyForNode(String(node.type), id, ref);
    rows.push({
      nodeId: id,
      nodeType: String(node.type),
      nodeRef: ref,
      fieldLabel: "Whole output",
      path,
      insertText: `@<${path}>@`,
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
      path: field.path,
      discovered: true,
      insertText: `@<${field.path}>@`,
      example: field.example,
    });
  }

  return rows;
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

  const rows: UpstreamFieldRow[] = [];
  for (const id of ordered) {
    const node = nodeById.get(id);
    if (node) rows.push(...fieldsForNode(node));
  }
  return rows;
}

/**
 * Collapses text to comparable letters+digits: "Sender first name" →
 * "senderfirstname", "OG_Sheets.Job No" → "ogsheetsjobno".
 *
 * Shared by the two things in this module that compare user-facing names —
 * auto-map-by-name (`matchFieldByName`) and picker narrowing
 * (`pathMatchesQuery`). One spelling, so tuning what counts as a separator can't
 * make the two disagree.
 */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
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
  const target = normalizeForMatch(targetLabel);
  return (
    fields.find((f) => normalizeForMatch(f.fieldLabel) === target) ??
    fields.find((f) => {
      const label = normalizeForMatch(f.fieldLabel);
      return label.includes(target) || target.includes(label);
    })
  );
}

/**
 * One pickable field, as the picker renders it.
 *
 * `path` is the same string as `insertText` without its `@<…>@` wrapper. It is
 * carried rather than re-derived because both consumers that need it — picker
 * narrowing on every keystroke, and the dangling-reference validator on every
 * graph change — would otherwise regex-unwrap a string that was built by
 * interpolating that exact value moments earlier.
 */
export type PickerFieldRow = {
  insertText: string;
  path: string;
  fieldLabel: string;
};

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
 * What a custom-feature source is matched by. Its entries are built by the
 * picker itself rather than carried here, and its tokens all read
 * `@<custom:serialNumber?…>@`, so this is their common opening — enough for
 * `cus` to keep the group and for `og` to drop it.
 */
const CUSTOM_SOURCE_MATCH = "custom";

/**
 * Narrows the picker to what the typed query can still become.
 *
 * The match is a PREFIX, not a substring: the query is the beginning of the very
 * string that will be inserted, so a candidate qualifies only while the user is
 * still typing it from the front. Substring matching would keep `Backlog_Sync`
 * on screen for a query of `og` and delay — or prevent — the narrowing to one
 * that lets the panel drill in on its own.
 *
 * It runs against the WHOLE path (`OG_Sheets.Job No`) rather than splitting at
 * the dot, which makes one rule cover three cases that would otherwise each need
 * their own: narrowing to a node (`OG_S`), narrowing to a field within it
 * (`OG_Sheets.j`), and the trigger fields that have no node segment at all and
 * ARE their own root (`commentId`).
 *
 * A source survives while any of its fields does, and each surviving source
 * carries only its matching fields — so drilling into the one that is left shows
 * that node's matching values rather than all of them. An empty query is the
 * whole list unchanged, which is what a picker opened by focus shows before
 * anything is typed.
 */
export function filterPickerSources(
  sources: PickerSource[],
  query: string,
): PickerSource[] {
  if (query === "") return sources;
  // Normalized ONCE, not per candidate: this runs over every pickable field of
  // every upstream node on each keystroke, and a Sheets node alone can carry
  // dozens.
  const target = normalizeForMatch(query);
  const matches = (path: string) => normalizeForMatch(path).startsWith(target);

  const filtered: PickerSource[] = [];
  for (const source of sources) {
    if (source.kind === "custom") {
      if (matches(CUSTOM_SOURCE_MATCH)) filtered.push(source);
      continue;
    }
    const fields = source.fields.filter((f) => matches(f.path));
    if (fields.length > 0) filtered.push({ ...source, fields });
  }
  return filtered;
}

/**
 * Strips the `@<path>@` wrapper down to the bare dotted path. Shared with the
 * picker, which inserts this form into fields that consume a raw path rather
 * than a template (`bare` mode).
 */
export function toBarePath(insertText: string): string {
  return insertText.replace(/^@<\s*/, "").replace(/\s*>@$/, "");
}

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
