import { z } from "zod";
import { ROW_SCOPES } from "@/lib/sheet-style";

/**
 * What an absent `rowScope` means for a TRIGGER: no distinction between data and
 * heading rows — exactly how the trigger behaved before it understood headings.
 *
 * Every reader resolves it this way, the dialog included. That uniformity is the
 * point. Resolving it as "data" in the dialog while the poll sync said "all"
 * meant opening an existing trigger to change the tab name and pressing Save
 * silently switched which rows fire it, with nothing on screen saying a choice
 * had been made. One default, so saving can only ever persist what the user was
 * actually shown.
 *
 * "all" rather than the shared `DEFAULT_ROW_SCOPE` ("data") the ACTION uses,
 * because the two are answering different questions — the action asks which rows
 * a filter may WRITE to, where skipping headings is the safe answer; the trigger
 * only watches. "all" is also the cheaper answer: it needs no merged-ranges
 * lookup, so a poll stays at one API call until someone opts into a
 * heading-aware scope.
 */
export const SHEETS_TRIGGER_DEFAULT_ROW_SCOPE = "all" as const;

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
  // Which KIND of row may fire — the same `data`/`headings`/`all` vocabulary the
  // Sheets ACTION uses, so "heading" means one thing across the product. Optional
  // because triggers saved before headings existed have no value; every reader
  // resolves that absence through `SHEETS_TRIGGER_DEFAULT_ROW_SCOPE`.
  rowScope: z.enum(ROW_SCOPES).optional(),
  ignoreColumns: z.array(z.string()).optional(),
};
