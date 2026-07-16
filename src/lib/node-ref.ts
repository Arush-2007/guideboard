/**
 * Single source of truth for a node's reference key — the human-readable,
 * per-workflow-unique identifier (e.g. `AI_TEXT_1`) that a node's output is
 * written under in the run context and that users reference downstream as
 * `@<AI_TEXT_1.output>@`.
 *
 * Kept dependency-free (no React, no Prisma) so the engine, the variable
 * picker, the editor, and the conversational builder all share one definition.
 */

/**
 * Trigger (and placeholder) node types that DON'T get a ref. Triggers seed
 * fixed context keys (e.g. `telegram`, `webhook`) — renaming those is a separate
 * step — and `INITIAL` is the empty-canvas placeholder, not a real node. This is
 * a denylist so EVERY other node type (actions, AI, Condition, reply nodes, and
 * any future node) automatically gets a friendly `TYPE_N` ref without having to
 * be added to a list.
 */
export const NON_REF_NODE_TYPES: ReadonlySet<string> = new Set([
  "INITIAL",
  "MANUAL_TRIGGER",
  "GOOGLE_FORM_TRIGGER",
  "TYPEFORM_TRIGGER",
  "GMAIL_TRIGGER",
  "GOOGLE_SHEETS_TRIGGER",
  "SCHEDULE_TRIGGER",
  "WEBHOOK_TRIGGER",
  "INSTAGRAM_COMMENT_TRIGGER",
  "YOUTUBE_COMMENT_TRIGGER",
  "TELEGRAM_TRIGGER",
]);

/** Whether a node of this type is assigned a `ref` — everything but triggers. */
export function nodeTypeHasRef(type: string): boolean {
  return !NON_REF_NODE_TYPES.has(type);
}

/** The legacy per-node context key (`<type>_<id>`) a ref replaces. */
export function legacyOutputKey(type: string, nodeId: string): string {
  return `${type.toLowerCase()}_${nodeId}`;
}

/**
 * Rewrites legacy `<type>_<id>` context-key references in a serialized blob to
 * the corresponding refs. Used when a batch of nodes gets refs assigned (the AI
 * builder) so references authored against the legacy key keep resolving. Cuids
 * are globally unique, so plain substring replacement is unambiguous.
 */
export function rewriteRefsInJson(
  json: string,
  legacyKeyToRef: Map<string, string>,
): string {
  let out = json;
  for (const [legacyKey, ref] of legacyKeyToRef) {
    out = out.split(legacyKey).join(ref);
  }
  return out;
}

/**
 * Resolves the context key a node writes its output under.
 *
 * Prefers the stored `ref`. Falls back to the legacy `<type>_<id>` form for
 * nodes created before refs existed (and during the backfill window), so the
 * engine and picker keep working whether or not a ref has been assigned yet.
 */
export function getOutputKeyForNode(
  nodeType: string,
  nodeId: string,
  ref?: string | null,
): string {
  return ref ?? `${nodeType.toLowerCase()}_${nodeId}`;
}

/**
 * Computes the next frozen ref for a newly created node of `type`, given the
 * refs already used in the workflow. Always suffixed (`AI_TEXT_1`, even when
 * it's the only one) and monotonic per type, so adding or deleting siblings
 * never renames an existing node. Numbers are never reused, so a reference can
 * never silently point at a different node.
 */
export function nextNodeRef(
  type: string,
  existingRefs: Iterable<string>,
): string {
  const prefix = `${type}_`;
  let max = 0;
  for (const ref of existingRefs) {
    if (!ref?.startsWith(prefix)) continue;
    const n = Number(ref.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${type}_${max + 1}`;
}

/**
 * The canvas-side carrier of a ref.
 *
 * On a React Flow node the ref lives at `data.ref`, NOT as a top-level field.
 * Three constraints force this and none of them are negotiable:
 *   - React Flow only hands `data` (plus id/type/selected) to a node component,
 *     so a top-level field is unreadable from the node that has to render it.
 *   - `toSnapshot` (editor/lib/history.ts) rebuilds nodes from id/type/position/
 *     data alone, so a top-level ref would be erased by the first undo.
 *   - `serializeSnapshot` hashes `data`, so a ref change correctly marks the
 *     editor dirty — which is what makes a rename (part 2) savable.
 *
 * The DB keeps `Node.ref` as its own column (it carries the
 * `@@unique([workflowId, ref])` constraint); `workflows.getOne` injects it into
 * `data` on read and `workflows.update` lifts it back out on write, so the
 * persisted `data` blob never stores a duplicate copy that could drift.
 */
export type RefCarrier = {
  type?: string | null;
  data?: Record<string, unknown> | null;
};

/** Safely reads a node's ref out of its untyped React Flow `data` blob. */
export function readNodeRef(data: RefCarrier["data"]): string | null {
  const ref = (data as { ref?: unknown } | null | undefined)?.ref;
  return typeof ref === "string" && ref.length > 0 ? ref : null;
}

/** Every ref currently in use on the canvas — the input to `nextNodeRef`. */
export function collectNodeRefs(nodes: RefCarrier[]): Set<string> {
  const refs = new Set<string>();
  for (const node of nodes) {
    const ref = readNodeRef(node.data);
    if (ref) refs.add(ref);
  }
  return refs;
}

/**
 * Stamps a freshly-created node with its ref, so it renders as `AI_TEXT_1` the
 * instant it lands on the canvas rather than only after a save round-trip.
 *
 * Mutates nothing: returns a new node. `usedRefs` is READ AND WRITTEN — pass the
 * same set across a batch (e.g. duplicating a multi-selection) so two nodes
 * created in one tick can't be handed the same ref. Ref-less types (triggers,
 * INITIAL) are returned untouched.
 */
export function withAssignedRef<T extends RefCarrier>(
  node: T,
  usedRefs: Set<string>,
): T {
  if (!node.type || !nodeTypeHasRef(node.type)) {
    return node;
  }
  const ref = nextNodeRef(node.type, usedRefs);
  usedRefs.add(ref);
  return { ...node, data: { ...(node.data ?? {}), ref } };
}

/**
 * Returns a node's `data` blob with any canvas-carried `ref` key removed, ready
 * to persist. The ref belongs to the `Node.ref` column (which owns the
 * `@@unique([workflowId, ref])` constraint), never the stored blob — so every
 * write path strips it here rather than each one inlining the same destructure,
 * and no blob can hold a second copy that drifts from the column.
 */
export function stripRefFromData(
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const { ref: _canvasRef, ...rest } = data ?? {};
  return rest;
}
