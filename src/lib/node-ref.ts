/**
 * Single source of truth for a node's reference key — the human-readable,
 * per-workflow-unique identifier (e.g. `AI_TEXT_1`) that a node's output is
 * written under in the run context and that users reference downstream as
 * `@<AI_TEXT_1.output>@`.
 *
 * Kept dependency-free (no React, no Prisma) so the engine, the variable
 * picker, the editor, and the conversational builder all share one definition.
 */

import { PLACEHOLDER_RE } from "@/lib/template-token";

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

/**
 * Maximum length of a ref, so a runaway rename can't produce a caption that
 * blows out the canvas or an unwieldy context key.
 */
export const MAX_REF_LENGTH = 48;

/**
 * Turns a user-typed node name into a token-safe ref slug.
 *
 * The ref is embedded literally inside `@<REF.path>@` context-key tokens, so it
 * must contain only `[A-Za-z0-9_]` — a space, dot, `>` or `@` would break the
 * placeholder grammar or the dot-path split. Runs of any other character
 * collapse to a single `_` ("Summarize resume!" -> "Summarize_resume"), edge
 * underscores are trimmed, and the result is capped. Returns `""` for input
 * that has no usable characters (e.g. all punctuation) — callers treat an empty
 * slug as an invalid name.
 */
export function toRefSlug(input: string): string {
  return input
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, MAX_REF_LENGTH)
    .replace(/_+$/, "");
}

/**
 * The shared token walk behind every ref-aware rewrite. Visits each `@<path>@`
 * placeholder and calls `transform` with the path's FIRST dot-segment (the
 * producing node's ref) and the remaining segments. `transform` returns the
 * replacement token text, or `null` to leave the token untouched.
 *
 * Matching on the first segment — never a raw substring — is what lets a rename
 * of `AI_TEXT_1` leave `AI_TEXT_10` (and an unrelated `SLACK_1`) alone, unlike
 * the blind `.split().join()` `rewriteRefsInJson` can use only because cuids are
 * globally unique.
 */
function mapRefTokens(
  text: string,
  transform: (firstSegment: string, restSegments: string[]) => string | null,
): string {
  return text.replace(PLACEHOLDER_RE, (match, path: string) => {
    const segments = path.split(".");
    const first = segments[0]?.trim() ?? "";
    const replaced = transform(first, segments.slice(1));
    return replaced ?? match;
  });
}

/**
 * Rewrites `@<oldRef>@` / `@<oldRef.path>@` placeholders in a single template
 * string to use `newRef`, preserving the rest of the path verbatim.
 */
export function renameRefInTemplate(
  template: string,
  oldRef: string,
  newRef: string,
): string {
  return mapRefTokens(template, (first, rest) =>
    first === oldRef ? `@<${[newRef, ...rest].join(".")}>@` : null,
  );
}

/**
 * Removes every `@<ref…>@` placeholder whose ref is in `refs` (replacing the
 * whole token with the empty string). Used when the producing nodes are deleted:
 * the reference is already dead, and blanking it stops a later node that reclaims
 * the same ref number from silently inheriting the dangling reference.
 */
export function removeRefsInTemplate(
  template: string,
  refs: ReadonlySet<string>,
): string {
  return mapRefTokens(template, (first) => (refs.has(first) ? "" : null));
}

/**
 * JSON-blob wrappers around the template rewriters: serialize the blob so a
 * reference is caught wherever it sits — a top-level field, a mapping value, a
 * nested array — then reparse. Both return a new object; the input is untouched.
 */
export function renameRefInData(
  data: Record<string, unknown> | null | undefined,
  oldRef: string,
  newRef: string,
): Record<string, unknown> {
  return JSON.parse(
    renameRefInTemplate(JSON.stringify(data ?? {}), oldRef, newRef),
  );
}

export function removeRefsInData(
  data: Record<string, unknown> | null | undefined,
  refs: ReadonlySet<string>,
): Record<string, unknown> {
  return JSON.parse(removeRefsInTemplate(JSON.stringify(data ?? {}), refs));
}

/**
 * Strips references to just-removed nodes out of the surviving nodes' data.
 *
 * Called from the editor's `onNodesChange` — the single choke point both delete
 * paths (the node's trash button via `deleteElements`, and the Delete key) flow
 * through — so a dangling `@<deletedRef…>@` can never outlive its producer and
 * later re-point at a new node that reclaims the same ref. Pure: returns a new
 * array, or the same `survivors` reference when nothing needs changing.
 */
export function clearRefsForRemovedNodes<T extends RefCarrier>(
  removed: RefCarrier[],
  survivors: T[],
): T[] {
  const refs = collectNodeRefs(removed);
  if (refs.size === 0) return survivors;
  return survivors.map((node) => ({
    ...node,
    data: removeRefsInData(node.data, refs),
  }));
}

/** The outcome of validating a rename before it is applied. */
export type RenameCheck =
  | { ok: true; slug: string }
  | { ok: false; reason: "empty" | "unchanged" | "duplicate" };

/**
 * Validates a typed node name against the rest of the graph and, if valid,
 * applies the rename across a node array: the target node's `data.ref` becomes
 * the sanitized slug, and every OTHER node's `data` has its `@<oldRef…>@`
 * references rewritten to the slug (token-aware). Pure — returns a new array —
 * so the editor's `setNodes` and unit tests share one definition of what a
 * rename does.
 *
 * `check` reports why a rename was rejected (empty/all-punctuation, unchanged,
 * or a duplicate of another node's ref) so the caller can surface the right
 * message; `nodes` is the unchanged input when `check.ok` is false.
 */
export function applyNodeRename<T extends { id: string } & RefCarrier>(
  nodes: T[],
  targetId: string,
  typed: string,
): { nodes: T[]; check: RenameCheck } {
  const slug = toRefSlug(typed);
  if (!slug) return { nodes, check: { ok: false, reason: "empty" } };

  const target = nodes.find((node) => node.id === targetId);
  const oldRef = readNodeRef(target?.data);
  if (slug === oldRef) {
    return { nodes, check: { ok: false, reason: "unchanged" } };
  }

  const taken = collectNodeRefs(
    nodes.filter((node) => node.id !== targetId),
  ).has(slug);
  if (taken) return { nodes, check: { ok: false, reason: "duplicate" } };

  const next = nodes.map((node) => {
    if (node.id === targetId) {
      return { ...node, data: { ...(node.data ?? {}), ref: slug } };
    }
    // Nothing to rewrite until the target has had a ref to be referenced by.
    if (!oldRef) return node;
    return { ...node, data: renameRefInData(node.data, oldRef, slug) };
  });

  return { nodes: next, check: { ok: true, slug } };
}
