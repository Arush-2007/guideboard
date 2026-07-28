import { z } from "zod";

/**
 * Which KIND of row may fire the Sheets TRIGGER.
 *
 * A MERGED row (a section title) is structurally a row like any other — its text
 * sits in the first column and merging is only a display effect — so without
 * this distinction, editing a title would fire the trigger as though data had
 * changed. This is also the only way to deliberately watch merged rows.
 *
 * Lives HERE, with the trigger's other options, rather than in `sheet-style.ts`:
 * the ACTION node has no row-scope selector at all. It expresses the same idea
 * more directly, with a `MERGED_ROW_COLUMN` condition in the filter editor it
 * already has, which can say "a merged row whose text contains X" rather than
 * only "merged rows". Both sides still agree on what MERGED means, because both
 * derive it from `mergedDataRows`.
 *
 * ⚠️ The stored VALUES are deliberately unchanged (`headings`, not `merged`):
 * they are persisted in `GoogleSheetsPoll.rowScope`, so renaming them would need
 * a data migration for no behavioural gain. Only the LABELS were reworded when
 * the "heading" vocabulary was dropped.
 */
export const ROW_SCOPES = ["data", "headings", "all"] as const;
export type RowScope = (typeof ROW_SCOPES)[number];

export const ROW_SCOPE_LABELS: Record<RowScope, string> = {
  data: "Normal rows only (skip merged rows)",
  headings: "Merged rows only",
  all: "All rows, merged rows included",
};

/** Does a row of this kind pass the given scope? */
export function rowPassesScope(scope: RowScope, isMerged: boolean): boolean {
  if (scope === "all") return true;
  return scope === "headings" ? isMerged : !isMerged;
}

/**
 * What an absent `rowScope` means: no distinction between normal and merged
 * rows — exactly how the trigger behaved before it understood merging.
 *
 * Every reader resolves it this way, the dialog included. That uniformity is the
 * point. Resolving it as "data" in the dialog while the poll sync said "all"
 * meant opening an existing trigger to change the tab name and pressing Save
 * silently switched which rows fire it, with nothing on screen saying a choice
 * had been made. One default, so saving can only ever persist what the user was
 * actually shown.
 *
 * "all" is also the cheaper answer: it needs no merged-ranges lookup, so a poll
 * stays at one API call until someone opts into a merge-aware scope.
 *
 * This is now the ONLY row-scope default. There was briefly a second one
 * (`DEFAULT_ROW_SCOPE = "data"`) left over from the deleted heading actions,
 * which contradicted this and was justified by a comment about behaviour that no
 * longer exists.
 */
export const SHEETS_TRIGGER_DEFAULT_ROW_SCOPE: RowScope = "all";

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
