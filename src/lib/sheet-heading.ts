import { z } from "zod";
import type { CompareOptions } from "@/features/executions/lib/compare";
import { compareOptionsSchemaFields } from "@/lib/compare-options-schema";

/**
 * The single source for the Google Sheets "append heading" row style — its zod
 * fragment, its bounds, and its defaults.
 *
 * A heading row is one merged cell spanning the table's columns, so unlike an
 * appended DATA row it has no column mapping: it carries one piece of text and
 * the formatting that makes it read as a section header. That formatting is user
 * config, which means it must be validated identically by the server schema
 * (`node-schemas.ts`) and by the dialog's own form schema — a plain `z.object()`
 * STRIPS undeclared keys on submit, so a dialog that restated a subset of these
 * fields would silently drop the rest (the same trap `compare-options-schema.ts`
 * exists to close).
 *
 * Kept zod-only and dependency-free so the editor can import it: the request
 * BUILDER that turns a format into Sheets `batchUpdate` requests lives in
 * `google-sheets.ts`, which pulls in ky + inngest and is server-only.
 */

/**
 * Horizontal placement of the heading text inside its merged band. These are
 * Sheets' own `horizontalAlignment` enum values, passed through verbatim.
 */
export const HEADING_ALIGNMENTS = ["LEFT", "CENTER", "RIGHT"] as const;
export type HeadingAlignment = (typeof HEADING_ALIGNMENTS)[number];

/**
 * Font-size bounds. Sheets itself accepts far more, but a heading outside this
 * range is a mis-typed value rather than an intent — and a 400-point row would
 * silently resize the sheet's row height for everyone looking at it.
 */
export const HEADING_FONT_SIZE = { min: 6, max: 48 } as const;

/** `#RRGGBB` — exactly what `hexToRgb` (google-sheets.ts) accepts. */
const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, "Pick a color");

export const headingFormatSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  fontSize: z
    .number()
    .int()
    .min(HEADING_FONT_SIZE.min)
    .max(HEADING_FONT_SIZE.max)
    .optional(),
  textColor: hexColor.optional(),
  backgroundColor: hexColor.optional(),
  align: z.enum(HEADING_ALIGNMENTS).optional(),
});

export type HeadingFormat = z.infer<typeof headingFormatSchema>;

/**
 * What an unconfigured heading looks like: bold, centered, black on white, one
 * step up from the sheet's default 10pt body text. White is deliberate rather
 * than "leave it alone" — an appended row can land on a banded grid slot, and a
 * heading striped like a data row does not read as a heading (the same reason
 * `whiteRowRequest` exists for added blank rows).
 */
export const DEFAULT_HEADING_FORMAT: Required<HeadingFormat> = {
  bold: true,
  italic: false,
  fontSize: 12,
  textColor: "#000000",
  backgroundColor: "#ffffff",
  align: "CENTER",
};

/**
 * Fills every unset field from `DEFAULT_HEADING_FORMAT`, so the writer always
 * has a COMPLETE format to send.
 *
 * Field-by-field with `??` rather than a spread: zod keeps an explicitly-passed
 * `undefined` as a present key, which a `{ ...defaults, ...format }` spread would
 * let overwrite the default with `undefined`.
 */
/**
 * Which KIND of row an action is allowed to act on.
 *
 * A heading row is structurally a row like any other (its text sits in the first
 * column — merging is only a display effect), so without this every filter that
 * happens to match a heading's text would overwrite or repaint a section title.
 *
 * - `data`     — skip heading rows. The DEFAULT for every action that takes a
 *                filter, because a filter written against your columns is asking
 *                about your data, never about a section title.
 * - `headings` — act ONLY on heading rows. This is how a heading gets edited or
 *                recoloured at all.
 * - `all`      — no distinction; the pre-heading behaviour, kept as an explicit
 *                opt-in for a tab where a merged row IS data.
 */
export const ROW_SCOPES = ["data", "headings", "all"] as const;
export type RowScope = (typeof ROW_SCOPES)[number];

export const ROW_SCOPE_LABELS: Record<RowScope, string> = {
  data: "Data rows only (skip headings)",
  headings: "Heading rows only",
  all: "All rows, headings included",
};

export const DEFAULT_ROW_SCOPE: RowScope = "data";

/** Does a row of this kind pass the given scope? */
export function rowPassesScope(scope: RowScope, isHeading: boolean): boolean {
  if (scope === "all") return true;
  return scope === "headings" ? isHeading : !isHeading;
}

/**
 * What a heading action does when its search matches SEVERAL headings.
 *
 * One vocabulary shared by every heading action, so "which of the matches?"
 * reads the same wherever it is asked. It deliberately spans both ideas the
 * row-level actions split across two separate fields — WHICH rows to act on
 * (`color_rows`' first/last/all) and WHETHER to run the following steps per row
 * (`find_rows`' fan-out) — because for a heading they are one question.
 *
 * - `first` / `last` — act on just the topmost / bottom-most match.
 * - `all`   — act on every match; the steps after this one still run ONCE.
 * - `each`  — act on every match AND run the steps after this one once per
 *             heading (fan-out, capped by `maxFanOutItems`).
 *
 * `all` is what makes `each` safe to add: without it there would be no way to
 * say "every heading, but don't fan out", which is what colouring has always
 * done — so turning fan-out on would have silently changed existing workflows.
 */
export const HEADING_MATCH_MODES = ["first", "last", "all", "each"] as const;
export type HeadingMatchMode = (typeof HEADING_MATCH_MODES)[number];

export const HEADING_MATCH_MODE_LABELS: Record<HeadingMatchMode, string> = {
  first: "Only the topmost matching heading",
  last: "Only the bottom-most matching heading",
  all: "Every matching heading",
  each: "Every matching heading, one run each",
};

/**
 * Narrows matches to the ones a mode selects. `all` and `each` both act on
 * every match — they differ only in whether the run fans out afterwards, which
 * is decided outside this function.
 */
export function selectHeadingMatches<T>(
  matches: T[],
  mode: HeadingMatchMode,
): T[] {
  if (mode === "first") return matches.slice(0, 1);
  if (mode === "last") return matches.slice(-1);
  return matches;
}

/**
 * The operators the "Find rows — heading" action offers.
 *
 * A deliberate subset of the row-match set: a heading always holds text (its
 * value is required), so `is empty` / `is not empty` are meaningless, and the
 * numeric and date operators have nothing to compare against. Keeping the list
 * short is the point of the action — it is a search box for headings, not the
 * general conditions editor.
 */
export const HEADING_MATCH_OPERATORS = [
  "equals",
  "contains",
  "not_equals",
  "not_contains",
] as const;
export type HeadingMatchOperator = (typeof HEADING_MATCH_OPERATORS)[number];

export const HEADING_MATCH_OPERATOR_LABELS: Record<
  HeadingMatchOperator,
  string
> = {
  equals: "Is exactly",
  contains: "Contains",
  not_equals: "Is not",
  not_contains: "Does not contain",
};

/**
 * The heading search itself. Both fields are optional: with no value the action
 * returns EVERY heading on the tab, which is the natural "list the sections"
 * query and a safe default (it is a read).
 *
 * Note there is no `column` — a heading's text always lives in the tab's first
 * column, so the executor supplies it at run time from the live header row.
 * That way a renamed first column can't break a saved node.
 *
 * The three matching restraints are spread from the ONE shared fragment, exactly
 * as the row conditions do: a heading search is a comparison like any other, and
 * restating the fields here would let this schema drift (a plain `z.object()`
 * strips undeclared keys, so a missing field is silently dropped on submit).
 */
export const headingFilterSchema = z.object({
  operator: z.enum(HEADING_MATCH_OPERATORS).optional(),
  value: z.string().optional(),
  ...compareOptionsSchemaFields,
});

export type HeadingFilter = z.infer<typeof headingFilterSchema>;

/**
 * The restraints a heading search actually runs with — the one place the
 * defaults live, shared by the dialog (so its toggles show the truth) and the
 * executor (so it compares by it).
 *
 * `ignoreCase` defaults ON, not off: this is a search box for section titles,
 * where "acme" failing to find "Acme" simply reads as broken — and it is what
 * every heading search did before the restraints existed, so saved nodes (which
 * carry no `ignoreCase`) keep matching exactly what they matched before.
 */
export function resolveHeadingFilterOptions(
  filter?: HeadingFilter | null,
): CompareOptions {
  return {
    ignoreCase: filter?.ignoreCase ?? true,
    ignoreChars: filter?.ignoreChars,
    numeric: filter?.numeric,
  };
}

/**
 * `#RRGGBB` — the one colour `color_heading` paints every matching heading.
 *
 * Deliberately a single colour rather than `color_rows`' ordered rule list: the
 * multi-colour case is already served by `color_rows` with
 * `rowScope: "headings"`, and restating that editor here would be two doors into
 * the same room. This action exists to make the common case one field.
 */
export const headingColorSchema = hexColor;

export function resolveHeadingFormat(
  format?: HeadingFormat | null,
): Required<HeadingFormat> {
  const f = format ?? {};
  return {
    bold: f.bold ?? DEFAULT_HEADING_FORMAT.bold,
    italic: f.italic ?? DEFAULT_HEADING_FORMAT.italic,
    fontSize: f.fontSize ?? DEFAULT_HEADING_FORMAT.fontSize,
    textColor: f.textColor ?? DEFAULT_HEADING_FORMAT.textColor,
    backgroundColor:
      f.backgroundColor ?? DEFAULT_HEADING_FORMAT.backgroundColor,
    align: f.align ?? DEFAULT_HEADING_FORMAT.align,
  };
}
