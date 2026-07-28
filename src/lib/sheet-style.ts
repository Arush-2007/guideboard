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
 * Every style property, and how it maps onto Sheets' `userEnteredFormat`.
 *
 * THE one table — `hasAnyCellFormat` walks it, and so does the request builder
 * (`cellFormatRequests` in google-sheets.ts). That is the point: adding a
 * property to `cellFormatSchema` and to this list is enough, and it cannot be
 * accepted by the schema, offered by the dialog, and then silently never sent.
 * Before this table the writer had its own hand-written chain, so a tenth
 * property meant editing three places and forgetting one was invisible.
 *
 * - `group`  — `cell` writes onto `userEnteredFormat` directly, `text` onto its
 *              nested `textFormat` (which is why the mask needs dotted paths).
 * - `api`    — Sheets' own field name, which differs from ours for the colours.
 * - `color`  — value is `#RRGGBB` and must go through `hexToRgb` before sending.
 *
 * Ordered as the dialog shows them.
 */
export const CELL_FORMAT_FIELDS = [
  { key: "bold", group: "text", api: "bold" },
  { key: "italic", group: "text", api: "italic" },
  { key: "underline", group: "text", api: "underline" },
  { key: "strikethrough", group: "text", api: "strikethrough" },
  { key: "fontSize", group: "text", api: "fontSize" },
  { key: "textColor", group: "text", api: "foregroundColor", color: true },
  {
    key: "backgroundColor",
    group: "cell",
    api: "backgroundColor",
    color: true,
  },
  { key: "align", group: "cell", api: "horizontalAlignment" },
  { key: "verticalAlign", group: "cell", api: "verticalAlignment" },
] as const satisfies ReadonlyArray<{
  key: keyof CellFormat;
  group: "cell" | "text";
  api: string;
  color?: true;
}>;

/** The style property names alone, DERIVED so the two can never disagree. */
export const CELL_FORMAT_KEYS = CELL_FORMAT_FIELDS.map(
  (f) => f.key,
) as ReadonlyArray<keyof CellFormat>;

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
 * Would this style step change nothing at all?
 *
 * Every style property starts out as "leave as is" and merging defaults to
 * "none", so a step that sets neither is easy to reach by accident — it would
 * read the tab and write nothing while reporting success. Asked in one place
 * because it is asked in four (the config schema, the dialog's form schema, the
 * `style_cells` executor guard, and the append's inline-style gate), and the
 * four had already begun to drift over whether the fallback was `"none"` or
 * `DEFAULT_MERGE_MODE`.
 */
export function isNoOpStyle(
  format?: CellFormat | null,
  mergeMode?: MergeMode | null,
): boolean {
  return (
    !hasAnyCellFormat(format) && (mergeMode ?? DEFAULT_MERGE_MODE) === "none"
  );
}

/**
 * Which columns a chosen subset actually covers, and what it would sweep up.
 *
 * A Sheets range cannot express a GAP, so a subset is applied as the min..max
 * SPAN of the chosen headers. Picking Name and Status while skipping Middle
 * would therefore style Middle too — silently doing more than was asked.
 *
 * Both sides need this and neither can own it alone: the dialog warns live, the
 * executor enforces (and the config schema can do neither, because a gap is
 * defined by the tab's live header ORDER, which the schema never sees). Written
 * once here — dependency-free, so the editor can import it — because the two
 * implementations it replaces had already diverged on whether header names
 * matched case-insensitively.
 *
 * `unknown` names are reported rather than ignored: styling a wider band than
 * asked for is exactly the failure this exists to prevent.
 */
export function resolveColumnBand(
  headers: string[],
  picked: string[],
): {
  startColumnIndex: number;
  endColumnIndex: number;
  /** Headers inside the span that were NOT picked. Non-empty ⇒ reject. */
  gap: string[];
  /** Picked names that are not on the tab at all. Non-empty ⇒ reject. */
  unknown: string[];
} {
  const wanted = picked.map((c) => c.trim()).filter(Boolean);
  if (wanted.length === 0) {
    return {
      startColumnIndex: 0,
      endColumnIndex: headers.length,
      gap: [],
      unknown: [],
    };
  }

  const indexOf = (name: string) =>
    headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

  const unknown = wanted.filter((name) => indexOf(name) === -1);
  const indexes = wanted.map(indexOf).filter((i) => i !== -1);
  if (indexes.length === 0) {
    return {
      startColumnIndex: 0,
      endColumnIndex: headers.length,
      gap: [],
      unknown,
    };
  }

  const startColumnIndex = Math.min(...indexes);
  const endColumnIndex = Math.max(...indexes) + 1;
  const gap = headers
    .slice(startColumnIndex, endColumnIndex)
    .filter((_h, i) => !indexes.includes(startColumnIndex + i));

  return { startColumnIndex, endColumnIndex, gap, unknown };
}

/**
 * Which matched rows a `style_cells` run acts on when several match.
 *
 * Its OWN vocabulary, not the shared `MULTI_MATCH_MODES`: styling deliberately
 * has no fan-out ("run the next steps once per row"), and `all` — the default,
 * and the only sensible reading of a filter that paints — has no counterpart
 * there.
 */
export const STYLE_MATCH_MODES = ["first", "last", "all"] as const;
export type StyleMatchMode = (typeof STYLE_MATCH_MODES)[number];

export const STYLE_MATCH_MODE_LABELS: Record<StyleMatchMode, string> = {
  all: "Style every match",
  first: "Only the topmost match",
  last: "Only the bottom-most match",
};

export const DEFAULT_STYLE_MATCH_MODE: StyleMatchMode = "all";
