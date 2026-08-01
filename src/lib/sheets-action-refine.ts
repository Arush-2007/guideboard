import type { z } from "zod";
import { hasActiveRowCondition } from "@/lib/row-match-operators";
import {
  type CellFormat,
  isNoOpStyle,
  type MergeMode,
} from "@/lib/sheet-style";

/**
 * The Google Sheets action's cross-field validation rules — the ONE copy, shared
 * by the server config schema (`node-schemas.ts`) and the editor dialog's own
 * form schema.
 *
 * ## Why this needs to be shared, when the FIELD lists deliberately are not
 *
 * The dual-schema convention (see `compare-options-schema.ts`) exists because a
 * plain `z.object()` STRIPS undeclared keys on parse, so the dialog must restate
 * every field it wants to survive submit. That argument applies to field
 * *declarations* only — it says nothing about *refinements*, which were being
 * copied verbatim purely because they sat next to the fields.
 *
 * Five rules and their exact user-facing message strings were duplicated across
 * the two schemas, and had already started to drift (one side spelled the merge
 * fallback `"none"`, the other `DEFAULT_MERGE_MODE`). A rule that reads
 * differently in the dialog than on the server is the worst kind of drift: the
 * form accepts a config the executor then rejects at run time.
 *
 * ⚠️ This validates only what BOTH sides can see — the saved config. Anything
 * needing the tab's live headers (whether `styleColumns` is contiguous, whether
 * a mapped column still exists) cannot be judged here and belongs in the dialog,
 * which has them, and in the executor, which is what writes.
 */

/** The subset of the config these rules read. Structural, so both schemas fit. */
type SheetsActionShape = {
  action?: string;
  position?: string;
  columnMappings?: Record<string, string>;
  conditions?: Array<{ column?: string; enabled?: boolean }>;
  cellFormat?: CellFormat;
  mergeMode?: MergeMode;
  styleAppendedRow?: boolean;
  mergedText?: string;
};

export function refineGoogleSheetsAction(
  data: SheetsActionShape,
  ctx: z.RefinementCtx,
): void {
  // The READ action needs only spreadsheet + tab, which the field schema
  // already requires.
  if (data.action === "find_rows") return;

  // style_cells uses no columnMappings, so it validates here and returns before
  // the mapping checks below.
  if (data.action === "style_cells") {
    // An empty filter makes matchRows vacuously true, so it would restyle every
    // row on the tab. Re-checked in the executor, which is what actually writes.
    if (!hasActiveRowCondition(data.conditions)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Add at least one condition — an empty filter would restyle every row",
        path: ["conditions"],
      });
    }
    // A step that sets no property and changes no merge would read the tab and
    // write nothing. That is a misconfiguration, not a no-op worth running — and
    // it is easy to reach, since every style property starts out as "leave as
    // is".
    if (isNoOpStyle(data.cellFormat, data.mergeMode)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Set at least one style property, or choose a merge option — otherwise this step would change nothing",
        path: ["cellFormat"],
      });
    }
    return;
  }

  const hasMappings = data.columnMappings
    ? Object.values(data.columnMappings).some((v) => v.trim())
    : false;
  const isUnderAppend =
    data.action === "append_row" && (data.position ?? "bottom") !== "bottom";

  // A merged row is ONE cell, so it carries one piece of text instead of a
  // column mapping — see `mergedText`. Without this, an append that merges would
  // write every mapped column and keep only whichever landed in column A.
  const mergingAppend =
    data.action === "append_row" &&
    data.styleAppendedRow === true &&
    data.mergeMode === "merge";
  if (mergingAppend && !data.mergedText?.trim()) {
    ctx.addIssue({
      code: "custom",
      message: "Merged row text is required",
      path: ["mergedText"],
    });
  }

  // update_row must map at least one column — with none it writes nothing.
  // append_row needs NO mapping in any position: a row with every column
  // unmapped is a blank row, which is a legitimate thing to append.
  if (data.action === "update_row" && !hasMappings) {
    ctx.addIssue({
      code: "custom",
      message: "Map at least one column to update",
      path: ["columnMappings"],
    });
  }

  // An empty filter matches EVERY row (matchRows is vacuously true with no
  // conditions). Harmless for find_rows — it just reads the tab — but both write
  // cases need a real filter: update_row would overwrite the entire sheet, and a
  // non-bottom append would "join" a group spanning every row, which is just a
  // bottom append wearing a filter's clothes. Enforced in the executor too —
  // that is what actually writes.
  if (
    (data.action === "update_row" || isUnderAppend) &&
    !hasActiveRowCondition(data.conditions)
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        data.action === "update_row"
          ? "Add at least one condition — an empty filter would overwrite every row"
          : "Add at least one condition — it picks the group the new row joins",
      path: ["conditions"],
    });
  }
}
