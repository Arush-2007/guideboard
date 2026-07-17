/**
 * Dependency-free header helpers shared by the Google Sheets executor (server)
 * and the Sheets config dialog (client).
 *
 * Kept in its OWN module — deliberately separate from `sheet-row.ts`, which
 * imports the Handlebars-backed templating engine (`renderTemplate`). The Sheets
 * dialog is a client component that only needs to compute header keys, so it
 * imports from here to avoid pulling Handlebars into its lazy-loaded bundle.
 */

/**
 * Strips characters that break dotted-path resolution from a header so it can
 * be used as an object key in `rowByHeader`. `getByPath` (templating +
 * friendly-output) splits paths on `.`, so a header like `"Job No."` must not
 * carry a dot or downstream `@<REF.rowByHeader.Job No>@` resolution would break.
 */
export function sanitizeHeaderKey(header: string): string {
  return header.trim().replace(/\./g, "");
}

/**
 * Context key under which a non-bottom append (position "under_group" /
 * "under_each") exposes the row a new row is being attached to — the LAST row of
 * the matched group, or in "below every match" mode the specific row it sits under.
 *
 * It is injected into the render context per inserted row and is NOT part of the
 * workflow context afterwards, so a column can be filled from the row above it
 * (`@<anchorRow.Job No>@`) without the key leaking downstream. Defined here, in
 * the dependency-free module, because the dialog builds the picker entries and
 * the executor builds the values — and the two must never drift.
 */
export const ANCHOR_ROW_KEY = "anchorRow";

/** The template path for one column of the anchor row (see ANCHOR_ROW_KEY). */
export function anchorRowPath(header: string): string {
  return `${ANCHOR_ROW_KEY}.${sanitizeHeaderKey(header)}`;
}
