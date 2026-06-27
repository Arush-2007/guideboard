/**
 * Single source of truth for a node's reference key — the human-readable,
 * per-workflow-unique identifier (e.g. `AI_TEXT_1`) that a node's output is
 * written under in the run context and that users reference downstream as
 * `!#AI_TEXT_1.output#!`.
 *
 * Kept dependency-free (no React, no Prisma) so the engine, the variable
 * picker, the editor, and the conversational builder all share one definition.
 */

/**
 * Node types that write their output under a per-node key (the engine's
 * `outputKey`). These are exactly the nodes that get a `ref`. Triggers seed
 * fixed context keys (e.g. `telegram`) and other nodes write fixed keys (e.g.
 * the AI reply generator's `aiReply`) or nothing (Condition), so they keep
 * `ref = null` and their existing behavior. Add a type here when its executor
 * starts writing `outputKey`.
 */
export const REF_NODE_TYPES: ReadonlySet<string> = new Set([
  "AI_TEXT",
  "ANTHROPIC",
  "DISCORD",
  "GEMINI",
  "GMAIL_ACTION",
  "GOOGLE_SHEETS_ACTION",
  "HTTP_REQUEST",
  "NOTION_ACTION",
  "OPENAI",
  "SLACK",
  "TELEGRAM_ACTION",
  "WHATSAPP_ACTION",
]);

/** Whether a node of this type is assigned a `ref` (see `REF_NODE_TYPES`). */
export function nodeTypeHasRef(type: string): boolean {
  return REF_NODE_TYPES.has(type);
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
