/**
 * Output-handle contract for the Google Sheets action node. Two of its four
 * actions branch, so the handle set depends on the selected action — this file
 * is the single source both the canvas node (handle ids become each edge's
 * stored `fromOutput`) and the executor (which emits one set via `routed(...)`)
 * read, so the two sides can never drift. The other two actions (`append_row`,
 * `insert_row_adjacent`) keep the single default output and appear nowhere here.
 */

/** `find_rows`: routed by whether any row matched the filter. */
export const FIND_ROWS_OUTPUTS = {
  FOUND: "found",
  NOT_FOUND: "notfound",
} as const;

export const FIND_ROWS_OUTPUT_HANDLES = [
  { id: FIND_ROWS_OUTPUTS.FOUND, label: "Found" },
  { id: FIND_ROWS_OUTPUTS.NOT_FOUND, label: "Not found" },
] as const;

/** `update_row`: routed by whether a row was actually written. */
export const UPDATE_ROW_OUTPUTS = {
  UPDATED: "updated",
  NO_MATCH: "no_match",
} as const;

export const UPDATE_ROW_OUTPUT_HANDLES = [
  { id: UPDATE_ROW_OUTPUTS.UPDATED, label: "Updated" },
  { id: UPDATE_ROW_OUTPUTS.NO_MATCH, label: "No match" },
] as const;

/**
 * Legacy single-output handle ids. Before these actions branched, every outgoing
 * edge carried `main` (AI-builder / persistence path) or `source-1` (an
 * editor-drawn edge) and fired unconditionally. The executor emits these as
 * aliases on the HAPPY path (Found / Updated) so a pre-branching workflow keeps
 * flowing exactly when it used to on a match — mirroring the Condition node's
 * pass-path aliasing.
 */
export const LEGACY_MAIN_OUTPUTS = ["main", "source-1"] as const;

/**
 * The output handles a given action exposes, or `undefined` for the two
 * non-branching actions (which then fall back to `BaseExecutionNode`'s single
 * default handle). `undefined` — not `[]` — so the default is preserved.
 */
export function sheetsActionOutputHandles(
  action?: string,
): { id: string; label: string }[] | undefined {
  if (action === "find_rows") return [...FIND_ROWS_OUTPUT_HANDLES];
  if (action === "update_row") return [...UPDATE_ROW_OUTPUT_HANDLES];
  return undefined;
}
