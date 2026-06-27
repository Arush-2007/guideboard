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
