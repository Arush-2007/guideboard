import { z } from "zod";

/**
 * The single source for a Google Sheets CELL STYLE — its zod fragment, its
 * bounds, and the rules for reading it.
 *
 * This is user config, which means it must be validated identically by the
 * server schema (`node-schemas.ts`) and by each dialog's own form schema — a
 * plain `z.object()` STRIPS undeclared keys on submit, so a dialog that restated
 * a subset of these fields would silently drop the rest (the same trap
 * `compare-options-schema.ts` exists to close).
 *
 * Kept zod-only and dependency-free so the editor can import it: the request
 * BUILDER that turns a format into Sheets `batchUpdate` requests lives in
 * `google-sheets.ts`, which pulls in ky + inngest and is server-only.
 */

/**
 * Horizontal placement of the text inside its cell. These are Sheets' own
 * `horizontalAlignment` enum values, passed through verbatim.
 */
export const CELL_ALIGNMENTS = ["LEFT", "CENTER", "RIGHT"] as const;
export type CellAlignment = (typeof CELL_ALIGNMENTS)[number];

export const CELL_ALIGNMENT_LABELS: Record<CellAlignment, string> = {
  LEFT: "Left",
  CENTER: "Center",
  RIGHT: "Right",
};

/** Sheets' own `verticalAlignment` enum values, passed through verbatim. */
export const CELL_VERTICAL_ALIGNMENTS = ["TOP", "MIDDLE", "BOTTOM"] as const;
export type CellVerticalAlignment = (typeof CELL_VERTICAL_ALIGNMENTS)[number];

export const CELL_VERTICAL_ALIGNMENT_LABELS: Record<
  CellVerticalAlignment,
  string
> = {
  TOP: "Top",
  MIDDLE: "Middle",
  BOTTOM: "Bottom",
};

/**
 * Font-size bounds. Sheets itself accepts far more, but a size outside this
 * range is a mis-typed value rather than an intent — and a 400-point row would
 * silently resize the sheet's row height for everyone looking at it.
 */
export const CELL_FONT_SIZE = { min: 6, max: 48 } as const;

/** `#RRGGBB` — exactly what `hexToRgb` (google-sheets.ts) accepts. */
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, "Pick a color");

/**
 * Every property is OPTIONAL, and unset means **leave the cell's existing value
 * alone** — not "use a default".
 *
 * This is the rule the whole styling feature rests on. Styling runs over rows
 * that already exist and that a person may have formatted by hand, so a style
 * step that sets only a background must not also write `bold: false` and strip
 * their formatting. There is deliberately NO `resolveCellFormat` counterpart
 * filling in defaults: an unset property has to stay unset all the way to the
 * `fields` mask that `cellFormatRequests` (google-sheets.ts) builds, because
 * that mask is what tells Sheets which properties to touch.
 */
export const cellFormatSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  fontSize: z
    .number()
    .int()
    .min(CELL_FONT_SIZE.min)
    .max(CELL_FONT_SIZE.max)
    .optional(),
  textColor: hexColor.optional(),
  backgroundColor: hexColor.optional(),
  align: z.enum(CELL_ALIGNMENTS).optional(),
  verticalAlign: z.enum(CELL_VERTICAL_ALIGNMENTS).optional(),
});

export type CellFormat = z.infer<typeof cellFormatSchema>;

/**
 * The style properties, in the order the dialog shows them — the ONE list both
 * the editor and `hasAnyCellFormat` walk, so a property added to
 * `cellFormatSchema` can't be silently missed by either.
 */
export const CELL_FORMAT_KEYS = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "fontSize",
  "textColor",
  "backgroundColor",
  "align",
  "verticalAlign",
] as const satisfies ReadonlyArray<keyof CellFormat>;

/**
 * Does this format actually set anything?
 *
 * `undefined` means "leave as is", so a format where every property is unset
 * would produce an empty `fields` mask — a write that changes nothing. Callers
 * use this to reject "a style step that styles nothing" at save time, and to
 * skip the API call entirely at run time.
 *
 * Note it tests for `undefined` specifically, not falsiness: `bold: false` is a
 * real instruction ("un-bold these cells"), and a `fontSize` can never be 0
 * given the bounds above.
 */
export function hasAnyCellFormat(format?: CellFormat | null): boolean {
  if (!format) return false;
  return CELL_FORMAT_KEYS.some((key) => format[key] !== undefined);
}

/**
 * What a style step does to the cells it selects, beyond formatting them.
 *
 * - `none`    — formatting only; any existing merge is left exactly as it is.
 * - `merge`   — join the selected band into ONE cell. This is how a section
 *               title / heading row is made.
 * - `unmerge` — split a merged band back into individual cells.
 */
export const MERGE_MODES = ["none", "merge", "unmerge"] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

export const MERGE_MODE_LABELS: Record<MergeMode, string> = {
  none: "Leave merging as it is",
  merge: "Merge the cells into one",
  unmerge: "Unmerge the cells",
};

export const DEFAULT_MERGE_MODE: MergeMode = "none";

/**
 * Which KIND of row an action is allowed to act on.
 *
 * A MERGED row is structurally a row like any other (its text sits in the first
 * column — merging is only a display effect), so without this every filter that
 * happens to match a merged row's text would fire on a section title.
 *
 * - `data`     — skip merged rows. The DEFAULT, because a filter written against
 *                your columns is asking about your data, never about a section
 *                title.
 * - `headings` — act ONLY on merged rows.
 * - `all`      — no distinction.
 *
 * ⚠️ The stored VALUES are deliberately unchanged (`headings`, not `merged`):
 * they are persisted in `GoogleSheetsPoll.rowScope`, so renaming them would need
 * a data migration for no behavioural gain. Only the LABELS below were reworded
 * when the "heading" vocabulary was dropped.
 *
 * Used by the Sheets TRIGGER only. The ACTION node expresses the same idea more
 * directly, with a `MERGED_ROW_COLUMN` condition in its normal filter editor.
 */
export const ROW_SCOPES = ["data", "headings", "all"] as const;
export type RowScope = (typeof ROW_SCOPES)[number];

export const ROW_SCOPE_LABELS: Record<RowScope, string> = {
  data: "Normal rows only (skip merged rows)",
  headings: "Merged rows only",
  all: "All rows, merged rows included",
};

export const DEFAULT_ROW_SCOPE: RowScope = "data";

/** Does a row of this kind pass the given scope? */
export function rowPassesScope(scope: RowScope, isMerged: boolean): boolean {
  if (scope === "all") return true;
  return scope === "headings" ? isMerged : !isMerged;
}
