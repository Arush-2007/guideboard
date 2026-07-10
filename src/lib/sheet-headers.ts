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
