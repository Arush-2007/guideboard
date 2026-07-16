/**
 * The single grammar for `@<path>@` reference placeholders — the canonical
 * user-facing token the field picker inserts and the templating resolver reads.
 *
 * Kept dependency-free and owned here (not in `templating.ts`) so both the
 * resolver and the ref-rename rewriter can share ONE definition without pulling
 * Handlebars into every consumer. If the token syntax ever changes, it changes
 * in exactly one place.
 *
 * `path` (capture group 1) is dot-separated; its first segment is the producing
 * node's ref (e.g. `AI_TEXT_1` in `@<AI_TEXT_1.output>@`).
 *
 * The regex is global. Use it only with `String.prototype.replace` or
 * `matchAll` (both stateless — `replace` resets `lastIndex`, `matchAll` clones
 * the regex). Do NOT drive it with `.exec`/`.test` in a loop, which would share
 * and corrupt `lastIndex` across callers.
 */
export const PLACEHOLDER_RE = /@<\s*([^>]+?)\s*>@/g;
