import { z } from "zod";

/**
 * The single source for the Google Sheets trigger's "Restraints" zod fields.
 * Spread into EVERY schema that validates the trigger's config — the server
 * config schema (`node-schemas.ts`) and the editor dialog's own form schema.
 *
 * Same reasoning as `compare-options-schema.ts`: a plain `z.object()` STRIPS
 * undeclared keys on parse, so a dialog whose schema omits these fields would
 * silently drop them on submit. One fragment keeps dialog and server in lockstep.
 *
 * `ignoreColumns` holds header (row-1) NAMES whose edits are IGNORED — the
 * columns the user unchecked in the picker. Names, not indices, so they resolve
 * at poll time and survive reordering. Absent or empty ignores nothing, so every
 * column (including ones added later) is watched — the default.
 *
 * Kept zod-only so it stays safe to import into the browser-side dialogs.
 */
export const sheetsTriggerOptionsSchemaFields = {
  ignoreColumns: z.array(z.string()).optional(),
};
