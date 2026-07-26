import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import {
  applyMultiMatchPolicy,
  assertFanOutCap,
  assertNoForeignFanOut,
} from "@/features/executions/lib/multi-match-policy";
import {
  type FanOutOutcome,
  isFanOut,
  type NodeExecutor,
  type NodeOutcome,
  routed,
  type WorkflowContext,
} from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { FAN_OUT_MARKER } from "@/inngest/fan-out";
import { parseCustomFeatureToken } from "@/lib/custom-feature-token";
import {
  ensureGridRows,
  getSheetGrid,
  headingDataRows,
  headingRowRequests,
  hexToRgb,
  nextFreeSheetRow,
  nonHeadingMerges,
  readSheetTable,
  sheetRange,
  sheetsAuthHeaders,
  sheetsBatchUpdateUrl,
  sheetsValuesBatchUpdateUrl,
  sheetsWrite,
  toSheetsError,
  whiteRowRequest,
} from "@/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import {
  MAX_FAN_OUT_ITEMS_LIMIT,
  type MultiMatchMode,
  readFanOutSeed,
  selectSingleMatch,
} from "@/lib/multi-match";
import {
  getRowCell,
  matchRows,
  type RowMatch,
  type RowMatchCondition,
} from "@/lib/row-match";
import { hasActiveRowCondition } from "@/lib/row-match-operators";
import { stripTextForcing, toSheetsCellValue } from "@/lib/sheet-cells";
import { ANCHOR_ROW_KEY, sanitizeHeaderKey } from "@/lib/sheet-headers";
import {
  DEFAULT_ROW_SCOPE,
  type HeadingFilter,
  type HeadingFormat,
  type HeadingMatchMode,
  type RowScope,
  resolveHeadingFilterOptions,
  rowPassesScope,
  selectHeadingMatches,
} from "@/lib/sheet-heading";
import {
  buildRowByHeader,
  buildSheetRow,
  findBlankRequired,
} from "@/lib/sheet-row";
import { renderTemplate } from "@/lib/templating";
import {
  COLOR_ROWS_OUTPUTS,
  FIND_ROWS_OUTPUTS,
  LEGACY_MAIN_OUTPUTS,
  UPDATE_ROW_OUTPUTS,
} from "./handles";

type SheetsAction =
  | "append_row"
  | "append_heading"
  | "find_rows"
  | "find_heading"
  | "update_row"
  | "update_heading"
  | "color_rows"
  | "color_heading";

/**
 * One `color_rows` rule: the background color, and the filter selecting the rows
 * it paints. Rules are applied top-to-bottom and the FIRST match wins.
 */
type ColorRule = {
  id?: string;
  color: string;
  conditions: RowMatchCondition[];
};

type RowPosition = "bottom" | "under_group" | "under_each";

type GoogleSheetsActionData = {
  action?: SheetsAction;
  // Where an appended row lands (append_row only). Absent ⇒ "bottom".
  position?: RowPosition;
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
  // "match the columns" mapping: column header -> template string.
  columnMappings?: Record<string, string>;
  // Headers that may not be blank on the row-creating actions (accessory "may
  // be blank" off).
  requiredColumns?: string[];
  // append_row/append_heading + bottom only: leave the first free row EMPTY as a
  // separator and write the new row one lower. Nothing blank is ever sent to
  // Sheets.
  blankRowAbove?: boolean;
  // append_heading only: the text of the merged heading row, and how it is
  // typeset. `headingFormat` is filled from DEFAULT_HEADING_FORMAT at write time.
  headingText?: string;
  headingFormat?: HeadingFormat;
  // find_heading only: which headings to return. Absent ⇒ all of them.
  headingFilter?: HeadingFilter;
  // update_row / color_rows / a non-bottom append: which KIND of row the filter
  // may select. Absent ⇒ "data" — a filter never touches a heading by accident.
  rowScope?: RowScope;
  // update_heading only: also re-apply `headingFormat` to the row it rewrites.
  restyleHeading?: boolean;
  // color_heading only: the one colour every matching heading is painted.
  headingColor?: string;
  // find_heading / color_heading: which of several matching headings to act on,
  // and whether the following steps run once or once per heading.
  onMultipleHeadings?: HeadingMatchMode;
  // AND-ed row filter, shared by find_rows (which returns the matches),
  // update_row (which writes them) and a non-bottom append (for which they are
  // the GROUP the new row joins). Both write cases require at least one.
  conditions?: RowMatchCondition[];
  // Multi-match policy for find_rows / update_row (see src/lib/multi-match.ts).
  // A non-bottom append has none — for it, several matches are a GROUP, not
  // candidates to choose between, so `position` decides where the row lands
  // instead. It still honours the fan-out cap in "under_each" mode.
  onMultipleMatches?: MultiMatchMode;
  maxFanOutItems?: number;
  // color_rows only: the ordered rule list. This action does NOT use the shared
  // `conditions` above — every rule carries its own filter.
  colorRules?: ColorRule[];
  // color_rows only: paint just the topmost matched row ("first"), just the
  // bottom-most ("last"), or every matched row ("all", the default). Its own key
  // — color_rows does not use the shared `onMultipleMatches` fan-out policy.
  onMultipleColorMatches?: "first" | "last" | "all";
};

const ERROR_PREFIX = "Google Sheets Action";

/**
 * Hard ceiling on how many rows one `color_rows` run may paint. The action
 * emits one `repeatCell` per row and has no per-node cap in its dialog (unlike
 * the fan-out actions, which have "Max rows"), so this is what stops a filter
 * that matches an entire tab from building a batchUpdate too large to send.
 * Matches MAX_FAN_OUT_ITEMS_LIMIT — the same "one run shouldn't touch more than
 * this" ceiling the fan-out cap tops out at.
 */
const MAX_COLORED_ROWS = MAX_FAN_OUT_ITEMS_LIMIT;

/**
 * How a row's values are interpreted on write.
 *
 * A DATA row uses `USER_ENTERED`, so numbers and dates parse as a user typing
 * them would expect (padded ids are protected separately, by `forceTextIds`).
 *
 * A HEADING is `RAW`: it is a label, never a value, so it must land in the cell
 * exactly as written. Under `USER_ENTERED` a heading of "0009" would be stored
 * as the number 9 (the verified failure `sheet-cells.ts` documents), "March
 * 2026" would become a date, and anything starting "=" would be evaluated as a
 * formula — a section title showing #NAME? instead of its text. `RAW` is a
 * better fix here than the force-text apostrophe the row builder uses, because
 * it leaves no write artifact to strip back off when the heading is read again.
 */
const HEADING_SAFE_VALUE_INPUT = (isHeading: boolean) =>
  isHeading ? "RAW" : "USER_ENTERED";

/**
 * The key a heading's text is stored under in a `rowsByHeader` row: the tab's
 * FIRST column.
 *
 * `readSheetTable` keys a blank header as `colN`, so an empty A1 must resolve to
 * `col1` rather than to "" — which would match no key at all and silently make
 * every heading read as empty text (and every heading search return everything).
 */
function firstColumnKey(headers: string[]): string {
  return (headers[0] ?? "").trim() || "col1";
}

/**
 * The row filter behind "Find rows — heading". A heading's text always lives in
 * the tab's FIRST column, so the column is supplied at run time from the live
 * header row rather than saved into the node — a renamed first column then can't
 * break a saved search.
 *
 * Restraints come from the filter itself, resolved through the one shared
 * `resolveHeadingFilterOptions` — so the toggles the dialog shows are exactly
 * what this compares by. Case is folded unless the node says otherwise, which is
 * both what a title search wants and what saved nodes already did.
 *
 * An empty value yields NO conditions, which `matchRows` treats as vacuously
 * true — every heading is returned. That is the intended "list the sections"
 * default, and it is safe because this action only reads.
 */
function headingFilterConditions(
  filter: HeadingFilter | undefined,
  headers: string[],
): RowMatchCondition[] {
  const value = filter?.value?.trim();
  if (!value) return [];
  return [
    {
      column: firstColumnKey(headers),
      operator: filter?.operator ?? "equals",
      value,
      ...resolveHeadingFilterOptions(filter),
    },
  ];
}

function parseValuesJson(raw: string): string[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NonRetriableError(`${ERROR_PREFIX}: values must be valid JSON`);
  }

  if (!Array.isArray(parsed)) {
    throw new NonRetriableError(`${ERROR_PREFIX}: values must be an array`);
  }

  if (parsed.length === 0) return [];
  if (Array.isArray(parsed[0])) {
    return (parsed as unknown[][]).map((row) =>
      row.map((cell) => String(cell ?? "")),
    );
  }

  return [(parsed as unknown[]).map((cell) => String(cell ?? ""))];
}

/**
 * Route a `find_rows` / `update_row` result down its HAPPY branch (Found /
 * Updated), carrying the legacy single-output aliases so pre-branching workflows
 * keep flowing. A fan-out outcome ("each" mode with matches) is returned
 * unchanged — it activates no edge in this run, dispatching children instead,
 * and each child reshapes its own seed onto the happy branch below.
 */
function routeHappy(
  outcome: WorkflowContext | FanOutOutcome,
  happyHandle: string,
): WorkflowContext | FanOutOutcome | NodeOutcome {
  if (isFanOut(outcome)) return outcome;
  return routed(outcome, [happyHandle, ...LEGACY_MAIN_OUTPUTS]);
}

export const googleSheetsActionExecutor: NodeExecutor<
  GoogleSheetsActionData
> = async ({ data, nodeId, outputKey, userId, context, step, publish }) => {
  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: GoogleSheetsActionData;
  try {
    config = parseNodeConfig(
      NodeType.GOOGLE_SHEETS_ACTION,
      data,
    ) as GoogleSheetsActionData;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }
  const action = config.action ?? "append_row";
  // The two row-ADDING actions. They place a row identically — same positions,
  // same read/plan-then-write split, same grid growth — and differ only in what
  // the row holds: append_row fills the mapped columns, append_heading writes one
  // piece of text and then merges + styles the band. So both flow through the
  // same two placement paths below, which branch on `isHeading` where the
  // CONTENT differs.
  const isHeading = action === "append_heading";
  const isAppending = action === "append_row" || isHeading;
  // Appending actions only: where the row lands. The two "under_*" positions run
  // the group-insert path below; "bottom" (the default) is a plain append.
  const position: RowPosition = config.position ?? "bottom";
  const spreadsheetId = decode(
    renderTemplate(config.spreadsheetId ?? "", context),
  ).trim();
  const sheetName = decode(
    renderTemplate(config.sheetName ?? "", context),
  ).trim();
  const range = decode(renderTemplate(config.range ?? "", context)).trim();

  const columnMappings = config.columnMappings ?? {};
  const hasMappings = Object.values(columnMappings).some(
    (v) => typeof v === "string" && v.trim(),
  );

  if (!spreadsheetId || !sheetName) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      `${ERROR_PREFIX}: spreadsheetId and sheetName are required`,
    );
  }

  // Fan-out child run: the engine re-ran this node with a per-item seed under
  // its own output key (this node fanned out in the parent run, "each" mode).
  // Reshape the seed into the ACTION'S OWN single-match output shape instead of
  // touching Sheets again, so downstream references resolve identically in
  // every mode. The parent already did all the work — for update_row it already
  // WROTE every matched row, so a child must not write again.
  const seed = readFanOutSeed(context, outputKey);
  if (seed) {
    const item = (seed.item ?? {}) as Record<string, unknown>;
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
    );

    // Common to both: the marker must survive. A retry of this child run has to
    // short-circuit again, and a later "each"-mode node in this run must see it
    // (the nested-fan-out guard reads it).
    const lineage = {
      index: seed.index,
      total: seed.total,
      [FAN_OUT_MARKER]: true,
    };

    if (action === "update_row") {
      // A child run represents one row the parent already updated — so it flows
      // only down the Updated branch (with the legacy aliases).
      return routeHappy(
        {
          ...context,
          [outputKey]: {
            action,
            spreadsheetId,
            sheetName,
            matched: true,
            matchCount: 1,
            // The item IS the row the parent wrote, header-keyed — the same
            // `rowByHeader.<col>` reference works in "first" and "each" mode.
            rowByHeader: item,
            ...lineage,
          },
        },
        UPDATE_ROW_OUTPUTS.UPDATED,
      );
    }

    if (isAppending && position === "under_each") {
      // The parent already inserted every row (one per matched row) — a child
      // must not insert again. Its item carries the row it handled, where that
      // row landed, and the row it was placed under, so siblings are
      // distinguishable even when their contents are identical.
      return {
        ...context,
        [outputKey]: {
          action,
          position,
          spreadsheetId,
          sheetName,
          matchCount: 1,
          insertedUnderGroup: true,
          rowIndex: item.rowIndex,
          // A heading row has one cell, not columns — it carries its text where
          // an appended data row carries its header-keyed row, so each action's
          // single-row output shape is the same in every mode.
          ...(isHeading
            ? { headingText: item.headingText ?? "" }
            : { rowByHeader: item.row ?? {} }),
          anchorRow: item.anchorRow ?? {},
          ...lineage,
        },
      };
    }

    // A heading fan-out child: the parent already found (and, for colouring,
    // already painted) every heading, so this run must touch nothing. It
    // reshapes its one item into the SAME single-match output shape a "first"
    // run produces, so a downstream reference resolves identically in every
    // mode.
    if (action === "find_heading" || action === "color_heading") {
      const heading = typeof item.heading === "string" ? item.heading : "";
      const rowIndex = typeof item.rowIndex === "number" ? item.rowIndex : null;
      const shared = {
        action,
        spreadsheetId,
        sheetName,
        matchCount: 1,
        headings: [heading],
        headingRowIndexes: rowIndex === null ? [] : [rowIndex],
        rowIndex,
        // Tab-level facts carried on the seed, so every pickable field resolves
        // in a child exactly as it does in a non-fan-out run.
        headingsOnTab:
          typeof item.headingsOnTab === "number" ? item.headingsOnTab : 0,
        nearMisses: typeof item.nearMisses === "number" ? item.nearMisses : 0,
        ...lineage,
      };
      return routeHappy(
        {
          ...context,
          [outputKey]:
            action === "color_heading"
              ? { ...shared, coloredCount: 1, color: config.headingColor }
              : // A child acted on exactly its one heading.
                { ...shared, actedCount: 1, firstHeading: heading },
        },
        action === "color_heading"
          ? COLOR_ROWS_OUTPUTS.COLORED
          : FIND_ROWS_OUTPUTS.FOUND,
      );
    }

    const columnValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(item)) {
      columnValues[key] = JSON.stringify([value]);
    }
    // A child run always carries a matched row, so it flows down the Found
    // branch (with the legacy aliases).
    return routeHappy(
      {
        ...context,
        [outputKey]: {
          action: "find_rows",
          spreadsheetId,
          sheetName,
          matchCount: 1,
          columns: Object.keys(item),
          rows: [item],
          columnValues,
          firstRow: item,
          ...lineage,
        },
      },
      FIND_ROWS_OUTPUTS.FOUND,
    );
  }

  // update_row needs a mapping to know what to change. find_rows reads the whole
  // tab, and append_row (any position) can always write — with no mapping it
  // appends a BLANK row (every column empty), which is a legitimate operation.
  // (update_row never uses `range`, so there is nothing to exempt for it.)
  if (action === "update_row" && !hasMappings) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      `${ERROR_PREFIX}: a column mapping is required`,
    );
  }

  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const rowScope: RowScope = config.rowScope ?? DEFAULT_ROW_SCOPE;

  /**
   * The tab's heading rows — and the tab's numeric id, which the same metadata
   * response already carries.
   *
   * THE single place a merge lookup happens. Every consumer goes through here:
   * `applyRowScope` (which decides what counts as a row for the filtering
   * actions) and `matchHeadings` (which the three heading actions share). Two
   * copies of "fetch merges, derive headings" would let the heading actions and
   * `rowScope: "headings"` silently disagree about what a heading is.
   *
   * Memoised for the run, because it is the expensive read (`includeMerges`) and
   * every caller wants the same answer: a colour pass previously paid for it
   * twice — once to find the headings, once more just to learn the `sheetId`
   * that first response already held.
   */
  let headingsCache: Promise<{
    /** data row → the width it is actually merged across. */
    headingRows: Map<number, number>;
    sheetId: number;
    /** Merged rows below the header that do NOT qualify — diagnostic only. */
    nearMisses: number;
  }> | null = null;
  const readHeadings = () => {
    headingsCache ??= (async () => {
      const grid = await getSheetGrid({
        accessToken,
        spreadsheetId,
        sheetName,
        includeMerges: true,
      });
      return {
        headingRows: headingDataRows(grid.merges),
        sheetId: grid.sheetId,
        nearMisses: nonHeadingMerges(grid.merges),
      };
    })();
    return headingsCache;
  };

  /**
   * Drop the matches this action's row scope excludes.
   *
   * A heading is structurally an ordinary row — its text sits in the first
   * column, merging being only a display effect — so any filter matching that
   * text would otherwise select it. Every FILTERING action funnels through here
   * so "what counts as a row" is answered in exactly one place; `find_rows` and
   * `find_heading` are the two whose answer is fixed by the action itself.
   *
   * `scope: "all"` needs no merge lookup, so the pre-heading behaviour costs
   * nothing extra.
   */
  const applyRowScope = async <T extends { index: number }>(
    matches: T[],
    scope: RowScope,
  ): Promise<T[]> => {
    if (scope === "all" || matches.length === 0) return matches;
    const { headingRows } = await readHeadings();
    return matches.filter((m) =>
      rowPassesScope(scope, headingRows.has(m.index)),
    );
  };

  /**
   * The HEADING rows of a tab that match this node's `headingFilter`, in sheet
   * order — the one question all three heading actions ask.
   *
   * `find_heading` returns them, `update_heading` rewrites the first, and
   * `color_heading` paints them all; sharing this means "which rows are
   * headings, and which of those did the user mean?" is answered once. Two
   * facts decide it, and both live here: membership comes only from the tab's
   * real merge ranges, and the search runs against the tab's first column
   * (where a merged heading keeps its text).
   *
   * Also returns the tab's TOTAL heading count, which is what lets a zero-match
   * run say whether the text matched nothing or the tab simply has no headings.
   */
  const matchHeadings = async (
    table: Awaited<ReturnType<typeof readSheetTable>>,
  ): Promise<{
    matches: RowMatch[];
    headingsOnTab: number;
    /** Merged rows on the tab that do not qualify as headings. */
    nearMisses: number;
    sheetId: number;
    /** The width a given data row is merged across, for re-merging it safely. */
    mergedWidthOf: (dataRow: number) => number | undefined;
  }> => {
    const { headingRows, sheetId, nearMisses } = await readHeadings();
    const matches = await applyRowScope(
      matchRows(
        table.rowsByHeader,
        headingFilterConditions(config.headingFilter, table.headers),
        context,
      ),
      "headings",
    );
    return {
      matches,
      headingsOnTab: headingRows.size,
      nearMisses,
      sheetId,
      mergedWidthOf: (dataRow) => headingRows.get(dataRow),
    };
  };

  /**
   * How this run treats several matching headings. Each action keeps the
   * default that preserves what it did before the mode existed: a search acted
   * on the topmost match, colouring painted every one.
   */
  const headingMode = (fallback: HeadingMatchMode): HeadingMatchMode =>
    config.onMultipleHeadings ?? fallback;

  /**
   * One fan-out item per heading — the shape a child run is reshaped back from.
   * Carries the heading itself plus the two TAB-LEVEL facts every child must be
   * able to report (`headingsOnTab`, `nearMisses`): a child does no API call, so
   * anything it can't carry it can't answer, and both are pickable variables. It
   * is a little redundant to repeat them per item, but they are two small numbers
   * and this is the only channel a child reads from.
   */
  const headingItems = (
    matches: RowMatch[],
    table: Awaited<ReturnType<typeof readSheetTable>>,
    tab: { headingsOnTab: number; nearMisses: number },
  ) =>
    matches.map((m) => ({
      heading: headingTextOf(m, table),
      rowIndex: m.index + 2,
      headingsOnTab: tab.headingsOnTab,
      nearMisses: tab.nearMisses,
    }));

  /** The heading text of a matched row: its first-column cell, trimmed. */
  const headingTextOf = (
    match: RowMatch,
    table: Awaited<ReturnType<typeof readSheetTable>>,
  ): string => getRowCell(match.row, firstColumnKey(table.headers)).trim();

  /**
   * Run one batch of FORMAT requests against this tab, in its own Inngest step.
   *
   * The single place the "look the tab up, send one batchUpdate, map the error"
   * shape lives. Callers supply only the requests, built from the tab's numeric
   * `sheetId` — everything else (the step boundary, the retry semantics, the
   * Sheets error mapping) is identical for every format pass and must stay that
   * way, so it is written once.
   *
   * `idempotent: true` throughout: every request these callers build sets a FIXED
   * format on FIXED cells (or merges an already-identical range), so an Inngest
   * retry reproduces the same result rather than compounding.
   *
   * A no-op when `buildRequests` yields nothing, so a run with nothing to format
   * makes no extra API call at all.
   */
  const applyFormatRequests = async (
    stepName: string,
    buildRequests: (sheetId: number) => unknown[],
  ): Promise<void> => {
    await step.run(stepName, async () => {
      try {
        const grid = await getSheetGrid({
          accessToken,
          spreadsheetId,
          sheetName,
        });
        const requests = buildRequests(grid.sheetId);
        if (requests.length === 0) return null;
        await sheetsWrite(
          sheetsBatchUpdateUrl(spreadsheetId),
          {
            headers: sheetsAuthHeaders(accessToken),
            json: { requests },
          },
          { idempotent: true },
        );
        return null;
      } catch (error) {
        throw await toSheetsError(error);
      }
    });
  };

  /**
   * Force the blank rows this run DELIBERATELY added to a solid-white background.
   * A blank row is never format-free: a `blankRowAbove` separator keeps the
   * banding at its grid slot, a blank bottom append can land on a banded row, and
   * a blank row inserted under a group inherits the color of the row above (see
   * `whiteRowRequest`).
   *
   * "Blank" is decided from CONFIG, not from the rendered row: a node adds a blank
   * row when it has no column mappings (or, for a bottom append, the
   * `blankRowAbove` separator). A MAPPED row whose values happen to render empty on
   * a given run is a data event, not a spacer — it keeps the sheet's banding, so a
   * row's background never depends on that run's upstream data.
   *
   * `rowNumbers` are 1-based sheet rows; each maps to grid row n − 1.
   */
  const whitenBlankRows = async (
    rowNumbers: number[],
    columnCount: number,
  ): Promise<void> => {
    if (rowNumbers.length === 0 || columnCount === 0) return;
    await applyFormatRequests("google-sheets-whiten-blank-rows", (sheetId) =>
      rowNumbers.map((n) => whiteRowRequest(sheetId, n - 1, columnCount)),
    );
  };

  /**
   * Turn the row(s) this run wrote into HEADINGS: style each band from
   * `headingFormat` and merge it into one cell (`headingRowRequests`). Any blank
   * separator row added alongside is forced white in the SAME batchUpdate, so a
   * "heading with a gap above it" costs one format call rather than two.
   *
   * Runs AFTER the value write — the text must exist before the cells are merged,
   * or the merge would swallow an empty cell and the write would then land on a
   * merged range.
   *
   * `rowNumbers` are 1-based sheet rows; each maps to grid row n − 1.
   */
  const styleHeadingRows = async (
    headingRows: number[],
    blankRows: number[],
    columnCount: number,
  ): Promise<void> => {
    if (headingRows.length === 0 || columnCount === 0) return;
    await applyFormatRequests("google-sheets-style-heading-rows", (sheetId) => [
      ...headingRows.flatMap((n) =>
        headingRowRequests({
          sheetId,
          gridRow0: n - 1,
          columnCount,
          format: config.headingFormat,
        }),
      ),
      ...blankRows.map((n) => whiteRowRequest(sheetId, n - 1, columnCount)),
    ]);
  };

  /**
   * The heading row's single cell, rendered against `rowContext` (which carries
   * the anchor row for a non-bottom placement, so a heading can name the group it
   * sits under). Rejects an empty result loudly rather than merging a blank band:
   * the config schema already requires the text, so an empty render means the
   * template's upstream value was missing, and silently writing an unlabelled
   * merged row would hide that.
   */
  const renderHeadingText = (rowContext: WorkflowContext): string => {
    const text = renderTemplate(config.headingText ?? "", rowContext).trim();
    if (!text) {
      throw new NonRetriableError(
        `${ERROR_PREFIX}: the heading text is empty — check the value it is built from`,
      );
    }
    return text;
  };

  try {
    // color_rows paints matched rows a background color. It lives outside the
    // shared step switch because it is the one action that touches FORMAT rather
    // than values — but unlike the append/update paths it needs only ONE step:
    // coloring never changes a cell's VALUE, so a replayed read re-matches
    // exactly the same rows and the repaint is a no-op.
    if (action === "color_rows") {
      const rules = config.colorRules ?? [];
      if (rules.length === 0) {
        throw new NonRetriableError(
          `${ERROR_PREFIX}: coloring rows needs at least one color rule`,
        );
      }
      // An empty filter makes matchRows vacuously true — that rule would paint
      // EVERY row in the tab. The config schema rejects this too; re-checked
      // here because the executor is what writes.
      for (const rule of rules) {
        if (!hasActiveRowCondition(rule.conditions)) {
          throw new NonRetriableError(
            `${ERROR_PREFIX}: every color rule needs at least one filter ` +
              `condition — a rule with an empty filter would color every row ` +
              `in "${sheetName}"`,
          );
        }
      }

      const painted = await step.run("google-sheets-color-rows", async () => {
        try {
          const table = await readSheetTable({
            accessToken,
            spreadsheetId,
            sheetName,
          });
          // The header row defines how wide the paint goes, so without one there
          // is nothing to color to. Guarded explicitly because with zero headers
          // every row reads as an empty object — an `is_empty` condition would
          // "match" every row and then paint a zero-width range.
          if (table.headers.length === 0) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: the sheet has no header row (row 1) to color up to`,
            );
          }

          // Same header-keying as find_rows, so the execution grid renders these
          // rows exactly like a find_rows result.
          const keyed = table.headers
            .map((c) => c.trim())
            .filter((c) => c.length > 0)
            .map((col) => [col, sanitizeHeaderKey(col)] as const);

          // FIRST RULE WINS: walk the rules in order and let each claim only the
          // rows no earlier rule took, so a row is painted exactly once however
          // many rules it satisfies.
          const claimed = new Map<
            number,
            { color: string; row: Record<string, string> }
          >();
          for (const rule of rules) {
            // Scope BEFORE claiming, so an excluded heading cannot consume a
            // rule that a later rule would have applied to a real row.
            for (const m of await applyRowScope(
              matchRows(table.rowsByHeader, rule.conditions, context),
              rowScope,
            )) {
              if (claimed.has(m.index)) continue;
              claimed.set(m.index, { color: rule.color, row: m.row });
            }
          }

          // Ascending sheet order — the run view lists rows top-to-bottom, not
          // in the order the rules happened to claim them.
          const claimedEntries = [...claimed.entries()].sort(
            (a, b) => a[0] - b[0],
          );

          // "first" paints only the topmost matched row and "last" only the
          // bottom-most (entries are already in sheet order); "all" (the default)
          // paints every matched row. Slicing HERE means everything below — the
          // summary, the cap check, and the write — sees exactly the rows this
          // run will paint. `.slice` is empty-safe, so a zero-match run stays a
          // clean no-op in every mode.
          const mode = config.onMultipleColorMatches ?? "all";
          const entries =
            mode === "first"
              ? claimedEntries.slice(0, 1)
              : mode === "last"
                ? claimedEntries.slice(-1)
                : claimedEntries;

          const summary = {
            // How many rows matched the color rules — ALL of them, even when
            // only one is painted. Same meaning as find_rows/update_row's
            // matchCount, so a downstream branch on "how many matched" reads the
            // true count in every mode.
            matchCount: claimedEntries.length,
            // How many this run actually painted: every match in "all", exactly
            // one in "first"/"last". `rows`/`rowIndexes`/`colors` below describe
            // THESE rows.
            coloredCount: entries.length,
            // Stored even when nothing matched, so the grid can still render
            // column headers.
            columns: keyed.map(([, key]) => key),
            // Capped like find_rows' `rows`, so painting a huge tab can't bloat
            // the run record.
            rows: entries.slice(0, 100).map(([, { row }]) => {
              const out: Record<string, string> = {};
              for (const [col, key] of keyed) {
                out[key] = getRowCell(row, col).trim();
              }
              return out;
            }),
            // Sheet row numbers (1-based, past the header) + the color each row
            // was actually painted — the two things this action answers.
            rowIndexes: entries.slice(0, 100).map(([index]) => index + 2),
            colors: entries.slice(0, 100).map(([, { color }]) => color),
          };

          // Nothing matched ⇒ nothing to write. Returned BEFORE the grid lookup
          // below, so a run that paints nothing — the steady state of a polling
          // workflow — costs one read instead of two.
          if (entries.length === 0) return summary;

          // Every other multi-row path in this node caps how much one run may
          // touch; this one has no per-node cap in its UI, so it enforces a hard
          // ceiling. Checked BEFORE the write: one repeatCell per painted row
          // means a filter matching an entire tab would otherwise build a
          // multi-megabyte batchUpdate that Sheets rejects or times out on,
          // after the user had already committed to it.
          if (entries.length > MAX_COLORED_ROWS) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: ${entries.length} rows match the color rules, ` +
                `which is more than this step colors in one run ` +
                `(${MAX_COLORED_ROWS}). Narrow the rules' conditions.`,
            );
          }

          // batchUpdate addresses the tab by numeric id, not name.
          const grid = await getSheetGrid({
            accessToken,
            spreadsheetId,
            sheetName,
          });

          // One repeatCell per painted row, all in ONE batchUpdate. The range is
          // bounded to the USED columns (A through the last header), so the
          // color stops where the data does instead of running off across the
          // empty right-hand side of the grid — which also keeps the file from
          // carrying formatting for hundreds of empty cells. Grid rows are
          // 0-based with the header at 0, so data row i is grid row i + 1.
          // `hexToRgb` throws on a malformed color — and it runs while the
          // requests are built, i.e. before anything is written.
          await sheetsWrite(
            sheetsBatchUpdateUrl(spreadsheetId),
            {
              headers: sheetsAuthHeaders(accessToken),
              json: {
                requests: entries.map(([index, { color }]) => ({
                  repeatCell: {
                    range: {
                      sheetId: grid.sheetId,
                      startRowIndex: index + 1,
                      endRowIndex: index + 2,
                      startColumnIndex: 0,
                      // Exclusive bound — the full header width, blank headers
                      // included, so the painted band matches the table exactly.
                      endColumnIndex: table.headers.length,
                    },
                    cell: {
                      userEnteredFormat: { backgroundColor: hexToRgb(color) },
                    },
                    fields: "userEnteredFormat.backgroundColor",
                  },
                })),
              },
            },
            // Sets each cell's FINAL color, so a retry repaints identically.
            { idempotent: true },
          );

          return summary;
        } catch (error) {
          throw await toSheetsError(error);
        }
      });

      await publish(
        nodeStatusChannel(userId).status({ nodeId, status: "success" }),
      );

      const output = {
        ...context,
        [outputKey]: {
          action,
          spreadsheetId,
          sheetName,
          ...painted,
        },
      };
      // Nothing painted ⇒ route the No-match branch so the downstream that
      // handles "no row to flag" runs. Keyed on coloredCount, not matchCount:
      // the branch is about whether a row was COLORED. (They agree today — a
      // matched row is always painted — but coloredCount states what the branch
      // actually means.)
      return painted.coloredCount === 0
        ? routed(output, [COLOR_ROWS_OUTPUTS.NO_MATCH])
        : routeHappy(output, COLOR_ROWS_OUTPUTS.COLORED);
    }

    // Rewrite the heading a filter selects, and optionally restyle it. The
    // ergonomic twin of `update_row` + `rowScope: "headings"` — same underlying
    // operation, but the column is implied and the search is one box.
    if (action === "update_heading") {
      // Restyling re-applies `headingFormat`. With none saved that would resolve
      // to DEFAULT_HEADING_FORMAT and silently overwrite whatever styling the
      // heading already had — "also restyle it" means keep it looking like a
      // heading, never reset it to this app's defaults. Fail instead.
      if (config.restyleHeading === true && !config.headingFormat) {
        throw new NonRetriableError(
          `${ERROR_PREFIX}: "restyle the heading" is on but the node has no saved ` +
            `style, so restyling would reset the heading to default formatting. ` +
            `Set the style, or turn restyling off to change only the text.`,
        );
      }

      // STEP 1 — read, find the heading, and settle exactly what will be
      // written. Memoized, so the write below replays this target rather than
      // re-reading a tab its own landed write already changed.
      const planned = await step.run(
        "google-sheets-update-heading-plan",
        async () => {
          try {
            const table = await readSheetTable({
              accessToken,
              spreadsheetId,
              sheetName,
            });
            // Same guard color_heading and the update_row plan both carry. Without
            // it a header-less tab yields columnCount 0, `styleHeadingRows`
            // early-returns, and the run reports a restyle that never happened.
            if (table.headers.length === 0) {
              throw new NonRetriableError(
                `${ERROR_PREFIX}: the sheet has no header row (row 1), so there is no column width to style the heading across`,
              );
            }
            const { matches, headingsOnTab, nearMisses, mergedWidthOf } =
              await matchHeadings(table);
            if (matches.length === 0) {
              return {
                matched: false as const,
                headingsOnTab,
                nearMisses,
                matchCount: 0,
              };
            }

            // "first" only: this action rewrites ONE heading. Rewriting several
            // to the same text would collapse distinct sections into duplicates,
            // which is never what a rename means.
            const target = matches[0];
            const previousHeading = headingTextOf(target, table);
            const newText = config.headingText?.trim()
              ? renderHeadingText(context)
              : previousHeading;

            return {
              matched: true as const,
              headingsOnTab,
              nearMisses,
              matchCount: matches.length,
              // 1-based sheet row: +1 for the 1-based grid, +1 for the header.
              rowIndex: target.index + 2,
              previousHeading,
              headingText: newText,
              // The width the heading is ACTUALLY merged across, not today's
              // header count. A heading merged when the tab had 3 columns stays
              // 3 wide after a 4th is added; re-merging it over 4 would overlap
              // the existing merge, which Sheets rejects — and it would fail
              // AFTER the text write had already landed. Falls back to the
              // header width only if the merge somehow reports none.
              columnCount: mergedWidthOf(target.index) || table.headers.length,
            };
          } catch (error) {
            throw await toSheetsError(error);
          }
        },
      );

      if (!planned.matched) {
        await publish(
          nodeStatusChannel(userId).status({ nodeId, status: "success" }),
        );
        return routed(
          {
            ...context,
            [outputKey]: {
              action,
              spreadsheetId,
              sheetName,
              matched: false,
              matchCount: 0,
              headingsOnTab: planned.headingsOnTab,
              nearMisses: planned.nearMisses,
            },
          },
          [UPDATE_ROW_OUTPUTS.NO_MATCH],
        );
      }

      // STEP 2 — write the text. A SINGLE-CELL range (`A7`, not `A7:ZZ7`): the
      // anchor is the only cell a merge actually has, so this never writes
      // across a merged band. RAW because a heading is a label — see
      // HEADING_SAFE_VALUE_INPUT.
      if (config.headingText?.trim()) {
        await step.run("google-sheets-update-heading-write", async () => {
          try {
            await sheetsWrite(
              sheetsValuesBatchUpdateUrl(spreadsheetId),
              {
                headers: sheetsAuthHeaders(accessToken),
                json: {
                  valueInputOption: HEADING_SAFE_VALUE_INPUT(true),
                  data: [
                    {
                      range: sheetRange(sheetName, `A${planned.rowIndex}`),
                      values: [[planned.headingText]],
                    },
                  ],
                },
              },
              { idempotent: true },
            );
            return null;
          } catch (error) {
            throw await toSheetsError(error);
          }
        });
      }

      // STEP 3 — optional restyle. The row is ALREADY merged, and re-merging an
      // identical range is a no-op, so this re-applies the format cleanly.
      if (config.restyleHeading === true) {
        await styleHeadingRows([planned.rowIndex], [], planned.columnCount);
      }

      await publish(
        nodeStatusChannel(userId).status({ nodeId, status: "success" }),
      );
      return routeHappy(
        {
          ...context,
          [outputKey]: {
            action,
            spreadsheetId,
            sheetName,
            matched: true,
            matchCount: planned.matchCount,
            headingsOnTab: planned.headingsOnTab,
            rowIndex: planned.rowIndex,
            headingText: planned.headingText,
            // The text BEFORE this run, so the execution page can show what
            // changed — and so a rename is auditable.
            previousHeading: planned.previousHeading,
            restyled: config.restyleHeading === true,
          },
        },
        UPDATE_ROW_OUTPUTS.UPDATED,
      );
    }

    // Paint every heading a filter selects. ONE step: colouring never changes a
    // cell's value, so a replayed read re-matches exactly the same rows and the
    // repaint is a no-op — the same reasoning color_rows relies on.
    if (action === "color_heading") {
      const color = config.headingColor?.trim();
      if (!color) {
        throw new NonRetriableError(
          `${ERROR_PREFIX}: coloring headings needs a color`,
        );
      }
      // Defaults to "all": painting every match is what this action did before
      // the mode existed, and "each" adds fan-out on top rather than replacing
      // it — so an existing node keeps behaving exactly as it was verified.
      const mode = headingMode("all");
      // "each" fans out afterwards and a paint cannot be un-painted, so the
      // nested-fan-out guard runs BEFORE the write.
      if (mode === "each") assertNoForeignFanOut(context, outputKey);

      const painted = await step.run(
        "google-sheets-color-heading",
        async () => {
          try {
            const table = await readSheetTable({
              accessToken,
              spreadsheetId,
              sheetName,
            });
            if (table.headers.length === 0) {
              throw new NonRetriableError(
                `${ERROR_PREFIX}: the sheet has no header row (row 1) to color up to`,
              );
            }

            const {
              matches: allMatches,
              headingsOnTab,
              nearMisses,
              sheetId,
              mergedWidthOf,
            } = await matchHeadings(table);
            // Narrow to what this mode paints BEFORE anything else, so the
            // summary, the cap and the write all describe the same rows.
            const matches = selectHeadingMatches(allMatches, mode);

            // "each" starts one child run per painted heading. Its cap is
            // enforced here, before the write — failing after N headings were
            // painted would leave the sheet changed by a run the user capped.
            if (mode === "each") {
              assertFanOutCap(matches.length, config.maxFanOutItems, "heading");
            }

            const summary = {
              // How many headings MATCHED the search — all of them, even when
              // only the topmost is painted. Same meaning as color_rows'
              // matchCount, so a downstream branch reads the true count.
              matchCount: allMatches.length,
              // How many this run actually painted.
              coloredCount: matches.length,
              headingsOnTab,
              nearMisses,
              headings: matches
                .slice(0, 100)
                .map((m) => headingTextOf(m, table)),
              headingRowIndexes: matches.slice(0, 100).map((m) => m.index + 2),
              items: headingItems(matches, table, {
                headingsOnTab,
                nearMisses,
              }),
              color,
            };
            // Nothing matched ⇒ nothing to write, and no second call.
            if (matches.length === 0) return summary;

            // Same ceiling color_rows enforces: one repeatCell per painted row,
            // checked BEFORE the write so an over-broad filter fails cleanly
            // instead of building a batch too large to send.
            if (matches.length > MAX_COLORED_ROWS) {
              throw new NonRetriableError(
                `${ERROR_PREFIX}: ${matches.length} headings match, which is more ` +
                  `than this step colors in one run (${MAX_COLORED_ROWS}). ` +
                  `Narrow the search.`,
              );
            }

            // `sheetId` came back with the merges above — no second metadata
            // read. `hexToRgb` throws on a malformed colour while the requests
            // are built, i.e. before anything is written.
            await sheetsWrite(
              sheetsBatchUpdateUrl(spreadsheetId),
              {
                headers: sheetsAuthHeaders(accessToken),
                json: {
                  requests: matches.map((m) => ({
                    repeatCell: {
                      range: {
                        sheetId,
                        startRowIndex: m.index + 1,
                        endRowIndex: m.index + 2,
                        startColumnIndex: 0,
                        // Paint exactly the heading's OWN merged width, not the
                        // tab's current header count. A heading merged narrower
                        // than the tab (e.g. added before later columns were)
                        // would otherwise get a colour band wider than its merge
                        // — and wider than update_heading's restyle, which sizes
                        // the same row via mergedWidthOf. Falls back to the
                        // header count when a row's width can't be resolved.
                        endColumnIndex:
                          mergedWidthOf(m.index) || table.headers.length,
                      },
                      cell: {
                        userEnteredFormat: { backgroundColor: hexToRgb(color) },
                      },
                      fields: "userEnteredFormat.backgroundColor",
                    },
                  })),
                },
              },
              // Fixed colour on fixed cells — safe for Inngest to retry.
              { idempotent: true },
            );
            return summary;
          } catch (error) {
            throw await toSheetsError(error);
          }
        },
      );

      await publish(
        nodeStatusChannel(userId).status({ nodeId, status: "success" }),
      );
      // `items` is fan-out fuel, not part of the recorded output — strip it
      // so a run record never carries the list twice.
      const { items, ...recorded } = painted;
      const output = {
        ...context,
        [outputKey]: { action, spreadsheetId, sheetName, ...recorded },
      };
      if (painted.coloredCount === 0) {
        return routed(output, [COLOR_ROWS_OUTPUTS.NO_MATCH]);
      }
      // In "each" mode, one child run per painted heading. Applied OUTSIDE the
      // step — the branded fan-out outcome carries a symbol that would not
      // survive a step's JSON checkpoint.
      const outcome = applyMultiMatchPolicy({
        mode: mode === "each" ? "each" : "first",
        maxItems: config.maxFanOutItems,
        items,
        context,
        outputKey,
        output: { action, spreadsheetId, sheetName, ...recorded },
        itemNoun: "heading",
      });
      return routeHappy(outcome, COLOR_ROWS_OUTPUTS.COLORED);
    }

    // A non-bottom append and update_row live OUTSIDE the single-step switch
    // below because each splits a read/plan from its write across two Inngest
    // steps: the under-append because a row must be created before it can be
    // filled; update_row so a retry of its idempotent write replays the memoized
    // target ranges instead of re-reading a sheet the landed write already
    // mutated (which could re-match a DIFFERENT row). The paired `step.run`s are
    // what make both safe.
    if (isAppending && position !== "bottom") {
      // "under_each" fans out one run per inserted row; "under_group" (and any
      // other non-bottom value) drops one row below the whole group. Derived
      // from `position` — the old `insertUnder` field it superseded.
      const insertUnder = position === "under_each" ? "each_row" : "group";

      // The filter is what picks the group. With none active, matchRows is
      // vacuously true — every row "matches", so the group is the whole tab and
      // the insert degenerates into an append. The schema rejects that; this is
      // the executor's own check, because the executor is what writes.
      if (!hasActiveRowCondition(config.conditions)) {
        throw new NonRetriableError(
          `${ERROR_PREFIX}: adding a row under a group needs at least one filter ` +
            `condition — it selects the group the new row joins in "${sheetName}"`,
        );
      }

      // "each_row" fans out afterwards, and a write cannot be un-written — so
      // the nested-fan-out guard runs BEFORE anything is written, not inside
      // applyMultiMatchPolicy (which only runs once the write is done).
      if (insertUnder === "each_row") {
        assertNoForeignFanOut(context, outputKey);
      }

      // STEP 1 — read the tab, build the row(s), and make room: append at the
      // bottom (nothing matched, or the group already ends there), or insert a
      // blank row under each anchor. Checkpointed on its own so a retry of step
      // 2 replays this result instead of inserting a SECOND set of rows.
      const placed = await step.run(
        "google-sheets-insert-adjacent",
        async () => {
          try {
            const table = await readSheetTable({
              accessToken,
              spreadsheetId,
              sheetName,
            });
            if (table.headers.length === 0) {
              throw new NonRetriableError(
                `${ERROR_PREFIX}: the sheet has no header row (row 1) to map columns to`,
              );
            }

            // The filter picks the GROUP the new row joins. Scoped, so a section
            // title is never mistaken for the group's last row — which would drop
            // the new row directly under a heading instead of under its data.
            const matches = await applyRowScope(
              matchRows(table.rowsByHeader, config.conditions ?? [], context),
              rowScope,
            );
            // "each_row" starts one child run per inserted row. Enforce the cap
            // HERE, before the write — failing after N rows have landed would
            // leave the sheet changed by a run the user asked to be capped.
            if (insertUnder === "each_row") {
              assertFanOutCap(matches.length, config.maxFanOutItems, "row");
            }

            // The ANCHORS: the rows a new row is attached to. In "group" mode
            // there is exactly one — the group's LAST row, so the new row lands
            // below the whole group. In "each_row" mode every match is an
            // anchor. Nothing matched ⇒ no anchor: the row starts a new group at
            // the bottom (`null` is that "no anchor" case, and it still writes).
            const anchorIndexes: Array<number | null> =
              matches.length === 0
                ? [null]
                : insertUnder === "each_row"
                  ? matches.map((m) => m.index)
                  : [matches[matches.length - 1].index];

            // Serial Numbers keep counting UP across the rows THIS run inserts,
            // so each row is built against the rows written so far, not just the
            // ones already in the tab. A padded id is force-text ("'0004") and
            // `parseInt` chokes on the apostrophe, so the copy fed back for the
            // max() computation has it stripped.
            const seenRows = [...table.rows];
            const built = anchorIndexes.map((anchorIdx) => {
              // An EXISTING row read from the sheet: Sheets consumed the
              // force-text apostrophe on write, so there is nothing to strip —
              // `buildRowByHeader` is a no-op on it beyond keying by header.
              const anchorRow =
                anchorIdx === null
                  ? {}
                  : buildRowByHeader(table.headers, table.rows[anchorIdx]);

              // A heading is ONE cell — no mapping, no serial, no required
              // columns. `@<anchorRow.…>@` still resolves, so the heading can
              // name the group it is placed under.
              if (isHeading) {
                const headingText = renderHeadingText({
                  ...context,
                  [ANCHOR_ROW_KEY]: anchorRow,
                });
                return {
                  anchorIdx,
                  row: [headingText],
                  anchorRow,
                  headingText,
                  rowByHeader: {},
                };
              }

              const row = buildSheetRow({
                headers: table.headers,
                mappings: columnMappings,
                // The anchor is in scope for THIS row only, so a column can be
                // filled from the row it sits under (`@<anchorRow.Job No>@`).
                // It is never merged into the workflow context, so it cannot
                // leak downstream.
                context: { ...context, [ANCHOR_ROW_KEY]: anchorRow },
                rows: seenRows,
                forceTextIds: true,
              });

              const blankRequired = findBlankRequired(
                table.headers,
                row,
                config.requiredColumns,
              );
              if (blankRequired.length > 0) {
                throw new NonRetriableError(
                  `${ERROR_PREFIX}: required column(s) may not be blank: ${blankRequired.join(", ")}`,
                );
              }

              seenRows.push(row.map(stripTextForcing));
              return {
                anchorIdx,
                row,
                anchorRow,
                // Kept on both shapes so `built` stays ONE type; only the
                // heading action ever reads it.
                headingText: "",
                rowByHeader: buildRowByHeader(table.headers, row),
              };
            });

            const base = {
              matchCount: matches.length,
              insertedUnderGroup: matches.length > 0,
              // Carried out so the post-write whitening can bound the white band
              // to the table's width without re-reading the header.
              columnCount: table.headers.length,
            };

            // Bottom of the data — nothing matched (a NEW group starts here), or
            // the single anchor already IS the last row, in which case adding
            // under it just means writing the first free row. No structural
            // insert is needed; step 2 writes it to its ABSOLUTE range like every
            // other row this action creates (never `:append` — see
            // `nextFreeSheetRow`). Grow the grid first so that row exists.
            const only = built[0];
            if (
              built.length === 1 &&
              (only.anchorIdx === null ||
                only.anchorIdx === table.rows.length - 1)
            ) {
              const rowIndex = nextFreeSheetRow(table);
              await ensureGridRows({
                accessToken,
                spreadsheetId,
                sheetName,
                throughRow: rowIndex,
              });
              return { ...base, rows: [{ ...only, rowIndex }] };
            }

            // Room has to be MADE. Grid rows are 0-based with the header at 0, so
            // data row i sits at grid row i + 1 and the slot under it is i + 2.
            const anchors = built.map((b) => b.anchorIdx as number);
            const startIndexes = anchors.map((i) => i + 2);
            const grid = await getSheetGrid({
              accessToken,
              spreadsheetId,
              sheetName,
            });

            const requests: unknown[] = [];
            // insertDimension can only address rows the GRID has. Inserting under
            // the very last data row of a sheet trimmed to its data would be out
            // of bounds, so grow the grid first — in the same batch, so it is
            // still one request.
            const shortfall = Math.max(...startIndexes) + 1 - grid.rowCount;
            if (shortfall > 0) {
              requests.push({
                appendDimension: {
                  sheetId: grid.sheetId,
                  dimension: "ROWS",
                  length: shortfall,
                },
              });
            }
            // BOTTOM-UP: inserting a row shifts every row below it down, so doing
            // the deepest insert first leaves the remaining (higher) indexes
            // exactly where they were computed.
            for (const startIndex of [...startIndexes].sort((a, b) => b - a)) {
              requests.push({
                insertDimension: {
                  range: {
                    sheetId: grid.sheetId,
                    dimension: "ROWS",
                    startIndex,
                    endIndex: startIndex + 1,
                  },
                  // Take the group's formatting (banding, borders, number
                  // formats) from the row above — the row it joins.
                  inheritFromBefore: true,
                },
              });
            }
            await sheetsWrite(sheetsBatchUpdateUrl(spreadsheetId), {
              headers: sheetsAuthHeaders(accessToken),
              json: { requests },
            });

            return {
              ...base,
              rows: built.map((b, k) => ({
                ...b,
                // Sheet row = the anchor's row + 1, pushed down one more for each
                // row inserted ABOVE this one in this same batch.
                rowIndex: (b.anchorIdx as number) + 3 + k,
              })),
            };
          } catch (error) {
            throw await toSheetsError(error);
          }
        },
      );

      // STEP 2 — write every row this run creates, all in ONE request, each to
      // its own ABSOLUTE range. Step 1 already made room (a structural insert) or
      // grew the grid, and it is memoized — so a retry here rewrites the exact
      // same cells rather than adding a row. USER_ENTERED (not a batchUpdate
      // `updateCells`) so numbers and dates parse as on every other Sheets write.
      await step.run("google-sheets-insert-adjacent-write", async () => {
        try {
          await sheetsWrite(
            sheetsValuesBatchUpdateUrl(spreadsheetId),
            {
              headers: sheetsAuthHeaders(accessToken),
              json: {
                valueInputOption: HEADING_SAFE_VALUE_INPUT(isHeading),
                data: placed.rows.map((r) => ({
                  range: sheetRange(
                    sheetName,
                    `A${r.rowIndex}:ZZ${r.rowIndex}`,
                  ),
                  values: [r.row],
                })),
              },
            },
            { idempotent: true },
          );
          return null;
        } catch (error) {
          throw await toSheetsError(error);
        }
      });

      if (isHeading) {
        // Merge + style each inserted row. The insert used `inheritFromBefore`,
        // so without this the heading would wear the group's banding.
        await styleHeadingRows(
          placed.rows.map((r) => r.rowIndex),
          [],
          placed.columnCount,
        );
      } else {
        // A blank spacer inserted under a group inherited the group's color via
        // `inheritFromBefore` above — repaint it white so the gap is clean. Keyed
        // on CONFIG: with no column mappings every inserted row is a deliberate
        // blank; a mapped insert keeps the group banding even if its values
        // render empty.
        await whitenBlankRows(
          hasMappings ? [] : placed.rows.map((r) => r.rowIndex),
          placed.columnCount,
        );
      }

      const first = placed.rows[0];
      // One item per inserted row: the row itself, where it landed, and the row
      // it was placed under — so a fan-out child can tell its row from its
      // siblings' (they may otherwise be identical).
      // `placed.rows[].row` (the raw write array, carrying the serial's
      // text-forcing apostrophe) stays internal — `rowByHeader` is that same row
      // cleaned up, and recording both would be two answers to one question.
      // A heading item carries its TEXT where a row item carries its columns —
      // exactly the pair the fan-out child branch above reshapes back out, so a
      // child's output has the same shape as a single-match run's.
      const items = placed.rows.map((r) =>
        isHeading
          ? {
              headingText: r.headingText,
              rowIndex: r.rowIndex,
              anchorRow: r.anchorRow,
            }
          : {
              row: r.rowByHeader,
              rowIndex: r.rowIndex,
              anchorRow: r.anchorRow,
            },
      );
      const output: Record<string, unknown> = {
        action,
        // Stamped so the execution view and variable picker tell an under-append
        // apart from a bottom append without re-deriving it from the config.
        position,
        spreadsheetId,
        sheetName,
        matchCount: placed.matchCount,
        insertedUnderGroup: placed.insertedUnderGroup,
        rowIndex: first.rowIndex,
        // A heading carries its text where an appended row carries its columns
        // (see the fan-out child branch above, which reshapes to the same pair).
        ...(isHeading
          ? {
              headingText: first.headingText,
              mergedColumns: placed.columnCount,
            }
          : { rowByHeader: first.rowByHeader }),
        anchorRow: first.anchorRow,
      };
      // Only "each_row" writes more than one row, and only then is the list
      // worth recording (in "group" mode `rowByHeader` already IS the one row).
      // Capped like find_rows' `rows`, so a large fan-out can't bloat the run
      // record — children still get the full list via `items`.
      // The row numbers ride alongside so the run view can say WHERE each added
      // row landed, which is the whole question this action answers.
      if (insertUnder === "each_row") {
        // Read off `placed.rows` rather than the union-typed `items` above. A
        // heading has no columns to grid, so it is recorded under a single
        // "heading" key — the run view then renders one readable cell per
        // inserted heading instead of an empty row.
        output.insertedRows = placed.rows
          .slice(0, 100)
          .map((r) => (isHeading ? { heading: r.headingText } : r.rowByHeader));
        output.insertedRowIndexes = placed.rows
          .slice(0, 100)
          .map((r) => r.rowIndex);
      }

      // Fan out one child per inserted row — but ONLY when rows were actually
      // inserted under matches. A no-match run wrote exactly one row (a new group
      // at the bottom); fanning out over it would be a lie, and fanning out zero
      // children would mark the whole downstream sub-graph SKIPPED.
      const outcome =
        insertUnder === "each_row" && placed.matchCount > 0
          ? applyMultiMatchPolicy({
              mode: "each",
              maxItems: config.maxFanOutItems,
              items,
              context,
              outputKey,
              output,
              itemNoun: "row",
            })
          : { ...context, [outputKey]: output };

      await publish(
        nodeStatusChannel(userId).status({ nodeId, status: "success" }),
      );
      return outcome;
    }

    // A BOTTOM append onto the sheet's live columns. Split read/plan from write
    // for the same reason update_row and the under-append are: the target row is
    // derived from a read, so it must be memoized — otherwise a retry would
    // re-read a sheet the landed write already changed and place a SECOND row.
    // The row goes to an ABSOLUTE range, never `:append` (see `nextFreeSheetRow`
    // for why that heuristic is unsafe). The legacy raw-`range` + `values` path
    // has no mapping and falls through to the single-step switch below.
    if (isHeading || (action === "append_row" && (hasMappings || !range))) {
      // STEP 1 — read the tab, build the row, and settle exactly which row it
      // lands on (growing the grid if the tab was trimmed to its data).
      const planned = await step.run("google-sheets-append-plan", async () => {
        try {
          const table = await readSheetTable({
            accessToken,
            spreadsheetId,
            sheetName,
          });
          if (table.headers.length === 0) {
            throw new NonRetriableError(
              isHeading
                ? `${ERROR_PREFIX}: the sheet has no header row (row 1), so there are no columns to merge the heading across`
                : `${ERROR_PREFIX}: the sheet has no header row (row 1) to map columns to`,
            );
          }
          // A heading IS its merge — that is the only thing that distinguishes
          // it from a data row. Sheets rejects a single-cell merge, so on a
          // one-column tab this would write text that no heading action could
          // ever find, update or color again, and that find_rows would return as
          // data. Fail loudly now rather than leave an invisible heading behind.
          if (isHeading && table.headers.length < 2) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: "${sheetName}" has only one column, so a heading ` +
                `row cannot be merged — and an unmerged heading is indistinguishable ` +
                `from an ordinary row, so nothing would be able to find it later. ` +
                `Add a second column, or use "Append row" instead.`,
            );
          }

          // A heading is ONE cell in column A, which the format step then merges
          // across the table — so it uses neither the column mapping, the serial
          // feature, nor the required-column rule.
          const headingText = isHeading ? renderHeadingText(context) : "";
          const newRow = isHeading
            ? [headingText]
            : buildSheetRow({
                headers: table.headers,
                mappings: columnMappings,
                context,
                // Data rows (header-aligned) so a Serial Number custom-feature
                // column autofills to max(existing)+1.
                rows: table.rows,
                // Keep every padded id (0006) as text — generated serial or a
                // value referenced in from another sheet alike. USER_ENTERED
                // would otherwise store it as a number and drop the leading
                // zeros.
                forceTextIds: true,
              });

          // Enforce required columns after the row is built (a serial cell is
          // always populated, so it never trips this).
          const blankRequired = isHeading
            ? []
            : findBlankRequired(table.headers, newRow, config.requiredColumns);
          if (blankRequired.length > 0) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: required column(s) may not be blank: ${blankRequired.join(", ")}`,
            );
          }

          // The separator is simply a row we skip: leaving the first free row
          // untouched IS the blank row. Nothing empty is ever sent to Sheets —
          // an all-empty payload row is what made `:append` mis-place the data.
          const rowIndex =
            nextFreeSheetRow(table) + (config.blankRowAbove ? 1 : 0);
          await ensureGridRows({
            accessToken,
            spreadsheetId,
            sheetName,
            throughRow: rowIndex,
          });

          return {
            rowIndex,
            row: newRow,
            headingText,
            rowByHeader: isHeading
              ? {}
              : buildRowByHeader(table.headers, newRow),
            columnCount: table.headers.length,
          };
        } catch (error) {
          throw await toSheetsError(error);
        }
      });

      // STEP 2 — write it to its absolute range. Retry-safe: the row number was
      // fixed by the memoized step above, so a replay rewrites the same cells.
      await step.run("google-sheets-append-write", async () => {
        try {
          await sheetsWrite(
            sheetsValuesBatchUpdateUrl(spreadsheetId),
            {
              headers: sheetsAuthHeaders(accessToken),
              json: {
                valueInputOption: HEADING_SAFE_VALUE_INPUT(isHeading),
                data: [
                  {
                    range: sheetRange(
                      sheetName,
                      `A${planned.rowIndex}:ZZ${planned.rowIndex}`,
                    ),
                    values: [planned.row],
                  },
                ],
              },
            },
            { idempotent: true },
          );
          return null;
        } catch (error) {
          throw await toSheetsError(error);
        }
      });

      // The blank rows this append DELIBERATELY produced, forced to white: the
      // `blankRowAbove` separator (always blank), and — for append_row — the
      // placed row itself when the node has no column mappings (a deliberately
      // blank append). Both can otherwise show the sheet's alternating-row
      // banding. A mapped row that renders empty is a data event, not a spacer —
      // left banded. A heading row is never blank (its text is required), so only
      // the separator above it qualifies.
      const blanks: number[] = [];
      if (config.blankRowAbove) blanks.push(planned.rowIndex - 1);
      if (isHeading) {
        // One batchUpdate: style + merge the heading, and clear the separator.
        await styleHeadingRows([planned.rowIndex], blanks, planned.columnCount);
      } else {
        if (!hasMappings) blanks.push(planned.rowIndex);
        await whitenBlankRows(blanks, planned.columnCount);
      }

      await publish(
        nodeStatusChannel(userId).status({ nodeId, status: "success" }),
      );
      return {
        ...context,
        [outputKey]: {
          action,
          spreadsheetId,
          sheetName,
          appendedRows: 1,
          // Surfaced so the run view can say a separator was left above.
          blankRowAbove: config.blankRowAbove === true,
          // Now exact rather than a guess, because we chose the row.
          rowIndex: planned.rowIndex,
          row: planned.row,
          // A heading reports the text it wrote and how wide the merged band is;
          // an appended row reports its header-keyed columns so downstream nodes
          // can pick them (force-text apostrophe + header dots stripped).
          ...(isHeading
            ? {
                headingText: planned.headingText,
                mergedColumns: planned.columnCount,
              }
            : { rowByHeader: planned.rowByHeader }),
        },
      };
    }

    if (action === "update_row") {
      // An empty filter makes matchRows vacuously true — it would select EVERY
      // row and overwrite the whole sheet. The config schema rejects this too;
      // re-checked here because the executor is what writes.
      if (!hasActiveRowCondition(config.conditions)) {
        throw new NonRetriableError(
          `${ERROR_PREFIX}: updating rows needs at least one filter condition — ` +
            `an empty filter would overwrite every row in "${sheetName}"`,
        );
      }

      const mode = config.onMultipleMatches ?? "first";
      // "each" fans out afterwards and a write cannot be un-written, so the
      // nested-fan-out guard runs BEFORE the write, not in applyMultiMatchPolicy.
      if (mode === "each") {
        assertNoForeignFanOut(context, outputKey);
      }

      // STEP 1 — read the tab, match, and compute each target row's FINAL,
      // absolute-range write. Checkpointed on its own so the write step below
      // replays these exact ranges/values on a retry instead of re-reading a
      // sheet the first (landed) write already changed — the same read-then-write
      // split the under-append makes, for the same retry-safety reason.
      const planned = await step.run("google-sheets-update-plan", async () => {
        try {
          const table = await readSheetTable({
            accessToken,
            spreadsheetId,
            sheetName,
          });
          if (table.headers.length === 0) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: the sheet has no header row (row 1) to map columns to`,
            );
          }

          // Same row-matching as find_rows: one editor, one matcher. Scoped
          // before anything is written — by default a filter written against
          // your columns never overwrites a section title.
          const matchedIndexes = (
            await applyRowScope(
              matchRows(table.rowsByHeader, config.conditions ?? [], context),
              rowScope,
            )
          ).map((m) => m.index);

          // The policy decides WHICH rows the write lands on, and it must be
          // settled BEFORE writing: the "error" check and the "each" cap run
          // here, not in applyMultiMatchPolicy after the write.
          if (matchedIndexes.length > 0) {
            if (mode === "error" && matchedIndexes.length > 1) {
              throw new NonRetriableError(
                `${ERROR_PREFIX}: ${matchedIndexes.length} rows match the filter, but ` +
                  `this step is set to fail when more than one does. Switch it to ` +
                  `update every matching row, or narrow the filter.`,
              );
            }
            if (mode === "each") {
              assertFanOutCap(
                matchedIndexes.length,
                config.maxFanOutItems,
                "row",
              );
            }
          }

          // Nothing matched ⇒ no targets ⇒ no write (a clean no-op success, so a
          // Condition node can branch on `matched`). Otherwise "each" writes
          // every matched row and the single-match modes write exactly one —
          // the topmost in "first", the bottom-most in "last".
          const single = selectSingleMatch(matchedIndexes, mode);
          const targets =
            mode === "each"
              ? matchedIndexes
              : single === undefined
                ? []
                : [single];

          // The final value of every cell in each target row. Mapped columns are
          // overwritten with the rendered value; everything else is `null`, which
          // Sheets leaves untouched. Writing the full, final value (rather than a
          // relative change) is what makes the retried write safe: it rewrites
          // identical cells instead of applying an edit twice.
          const writes = targets.map((rowIdx) => {
            const existing = table.rows[rowIdx];
            const finalRow = table.headers.map((rawHeader) => {
              const header = rawHeader.trim();
              const mapping = columnMappings[header];
              // Unmapped ⇒ null ⇒ Sheets leaves the cell untouched.
              if (!mapping?.trim()) return null;
              // A serial is assigned once, at insert; updating a row must never
              // reassign it (v4 decision #7).
              if (
                parseCustomFeatureToken(mapping)?.featureId === "serialNumber"
              ) {
                return null;
              }
              // Force-text for a padded id, same rule the row builder applies on
              // insert — otherwise USER_ENTERED rewrites "0009" as the number 9
              // and an update silently strips a job number's padding.
              return toSheetsCellValue(renderTemplate(mapping, context));
            });

            // Sheet row number: +1 for the 1-based grid, +1 for the header row.
            const sheetRow = rowIdx + 2;
            // The row's resulting state — written cells where we wrote, the
            // existing cell where we passed null — so `rowByHeader` reflects the
            // whole row (W1's SWITCH reads unmapped columns off it too).
            const mergedRow = table.headers.map((_h, col) => {
              const written = finalRow[col];
              return written === null ? (existing[col] ?? "") : String(written);
            });

            return {
              rowIndex: sheetRow,
              valueRange: {
                range: sheetRange(sheetName, `A${sheetRow}:ZZ${sheetRow}`),
                values: [finalRow],
              },
              // The row as it stood BEFORE this write — the execution page shows
              // it next to the new state so a user can see what changed.
              previousRow: buildRowByHeader(table.headers, existing),
              rowByHeader: buildRowByHeader(table.headers, mergedRow),
            };
          });

          return { matchCount: matchedIndexes.length, writes };
        } catch (error) {
          throw await toSheetsError(error);
        }
      });

      // Nothing matched — a clean no-op success (nothing written). Route the
      // No-match branch so the downstream that handles the missing row runs
      // (e.g. an Append). This covers every mode: a 0-match run never fans out.
      if (planned.writes.length === 0) {
        await publish(
          nodeStatusChannel(userId).status({ nodeId, status: "success" }),
        );
        return routed(
          {
            ...context,
            [outputKey]: {
              action,
              spreadsheetId,
              sheetName,
              matched: false,
              matchCount: 0,
            },
          },
          [UPDATE_ROW_OUTPUTS.NO_MATCH],
        );
      }

      // STEP 2 — write in its OWN step. `planned.writes` is memoized above, so a
      // retry replays the SAME absolute ranges + final values; idempotent:true
      // lets Inngest retry a transient timeout instead of failing the run, with
      // no whole-step re-read that could re-match a different row.
      await step.run("google-sheets-update-write", async () => {
        try {
          await sheetsWrite(
            sheetsValuesBatchUpdateUrl(spreadsheetId),
            {
              headers: sheetsAuthHeaders(accessToken),
              json: {
                valueInputOption: "USER_ENTERED",
                data: planned.writes.map((w) => w.valueRange),
              },
            },
            { idempotent: true },
          );
          return null;
        } catch (error) {
          throw await toSheetsError(error);
        }
      });

      const output: Record<string, unknown> = {
        action,
        spreadsheetId,
        sheetName,
        matched: true,
        matchCount: planned.matchCount,
        rowIndex: planned.writes[0].rowIndex,
        previousRow: planned.writes[0].previousRow,
        rowByHeader: planned.writes[0].rowByHeader,
      };

      // In "each" mode, fan out one child run per updated row. Applied OUTSIDE
      // the step — the branded fan-out outcome carries a symbol that would not
      // survive a step's JSON checkpoint. "first"/"last" planned a single
      // target above, so `writes` already holds just that one row.
      const items = planned.writes.map((w) => w.rowByHeader);
      const outcome = applyMultiMatchPolicy({
        mode: config.onMultipleMatches,
        maxItems: config.maxFanOutItems,
        items,
        context,
        outputKey,
        output,
        itemNoun: "row",
      });

      await publish(
        nodeStatusChannel(userId).status({ nodeId, status: "success" }),
      );
      // Past the no-match early return, so ≥1 row was written — route the
      // Updated branch ("each" mode's fan-out passes through untouched).
      return routeHappy(outcome, UPDATE_ROW_OUTPUTS.UPDATED);
    }

    const result = await step.run("google-sheets-action", async () => {
      if (action === "append_row") {
        // Only the LEGACY raw-values path reaches here: an explicit `range` with
        // no column mapping. The mapped path (the one every current node uses)
        // was handled above as a planned, absolute-range write. This one keeps
        // `:append` because the user chose the range and supplies raw rows, so
        // there is no header table to derive a row number from.
        const a1Range = sheetRange(sheetName, range);
        const renderedValues = decode(
          renderTemplate(config.values ?? "", context),
        ).trim();
        const values = parseValuesJson(renderedValues);

        await sheetsWrite(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(a1Range)}:append`,
          {
            headers,
            searchParams: { valueInputOption: "USER_ENTERED" },
            json: { values },
          },
        );

        return {
          ...context,
          [outputKey]: {
            action,
            spreadsheetId,
            sheetName,
            range,
            appendedRows: values.length,
          },
        };
      }

      if (action === "find_rows" || action === "find_heading") {
        try {
          const table = await readSheetTable({
            accessToken,
            spreadsheetId,
            sheetName,
          });

          // Every column is returned ("columns to return" was removed), each
          // paired with its sanitized output key, computed once. Trim-tolerant;
          // blanks dropped.
          const keyed = table.headers
            .map((c) => c.trim())
            .filter((c) => c.length > 0)
            .map((col) => [col, sanitizeHeaderKey(col)] as const);

          const headingSearch = action === "find_heading";

          // HEADINGS ARE NOT DATA ROWS. `find_heading` returns nothing else
          // (via the shared `matchHeadings`), and `find_rows` must never return
          // one — even when its filter happens to equal a heading's text
          // (searching "Job No equals Acme" on a tab with an "Acme" heading
          // otherwise hits it).
          //
          // Membership is decided by the tab's real MERGE ranges, and ONLY by
          // them — so a data row that merely looks like a heading is never
          // wrongly hidden, and a real heading carrying a stray cell is never
          // wrongly returned.
          //
          // There is no shape pre-filter gating this lookup. One was tried, to
          // save an API call when no matched row "looked like" a heading, and it
          // was wrong in both directions: it let a heading with a leftover value
          // through find_rows as if it were data, and the same heuristic is one
          // the heading search itself refuses to trust. A rule the code won't
          // rely on for one action must not silently decide the other.
          //
          // The cost is one metadata read per row-reading run, and only rows are
          // read here — the write paths never pay it (getSheetGrid defaults to
          // omitting merges).
          let headingsOnTab = 0;
          let nearMisses = 0;
          let totalMatched = 0;
          let matches: RowMatch[];
          if (headingSearch) {
            const found = await matchHeadings(table);
            headingsOnTab = found.headingsOnTab;
            nearMisses = found.nearMisses;
            totalMatched = found.matches.length;
            // Narrow to what the mode acts on. Defaults to "all": listing every
            // match and running the following steps ONCE is exactly what this
            // action did before the mode existed, so an existing node is
            // unaffected. ("first" would have quietly truncated `headings` to a
            // single entry — a real behaviour change dressed up as a default.)
            matches = selectHeadingMatches(found.matches, headingMode("all"));
          } else {
            matches = await applyRowScope(
              matchRows(table.rowsByHeader, config.conditions ?? [], context),
              "data",
            );
            totalMatched = matches.length;
          }

          // Multi-match policy is applied OUTSIDE this step (see below) — but
          // "each" needs every match as a fan-out item, so its cap is enforced
          // HERE on the true count (silently truncating children would be worse
          // than failing) before hauling the rows across the step checkpoint.
          //
          // The two actions read DIFFERENT fields: find_rows uses the shared
          // `onMultipleMatches` (first/each/error), find_heading its own
          // `onMultipleHeadings` (first/last/all/each). Keeping them apart is
          // what stops a node switched between the two from inheriting a policy
          // its dialog cannot show — which previously failed runs on a cap the
          // user could not see, let alone clear.
          const mode = headingSearch
            ? headingMode("all") === "each"
              ? "each"
              : "first"
            : (config.onMultipleMatches ?? "first");
          if (mode === "each") {
            assertFanOutCap(
              matches.length,
              config.maxFanOutItems,
              headingSearch ? "heading" : "row",
            );
          }

          // A heading has no columns, so it reports TEXT and WHERE — not the
          // column grid find_rows returns. `headings`/`headingRowIndexes` are
          // positionally paired; `firstHeading` + `rowIndex` are the single-match
          // shortcuts a downstream node references.
          if (headingSearch) {
            const headings = matches.map((m) => headingTextOf(m, table));
            return {
              ...context,
              [outputKey]: {
                action,
                spreadsheetId,
                sheetName,
                // How many headings MATCHED the search — all of them, even
                // when the mode acts on only one. Same meaning as find_rows'
                // matchCount, so a downstream branch reads the true count.
                matchCount: totalMatched,
                // How many this run actually acted on: one in first/last, all
                // of them in all/each. `headings` describes THESE.
                actedCount: matches.length,
                headings: headings.slice(0, 100),
                // 1-based sheet rows: +1 for the 1-based grid, +1 for the header.
                headingRowIndexes: matches
                  .slice(0, 100)
                  .map((m) => m.index + 2),
                firstHeading: headings[0] ?? "",
                rowIndex: matches.length > 0 ? matches[0].index + 2 : null,
                // Fan-out fuel in "each" mode; stripped from the recorded output
                // below so the run record never carries the list twice.
                items: headingItems(matches, table, {
                  headingsOnTab,
                  nearMisses,
                }),
                // How many heading rows exist on the tab AT ALL, regardless of
                // the search text. Without this a zero-result run is unreadable:
                // it cannot distinguish "your text matched nothing" from
                // "nothing on this tab is a merged heading in the first place"
                // — the row was typed by hand, unmerged, or its merge spans more
                // than one row. The run view leads with this number.
                headingsOnTab,
                // …and how many merged rows were REJECTED, which is what turns
                // "this tab has no headings" from a dead end into a diagnosis.
                nearMisses,
              },
            };
          }

          // Stored rows are capped ("each" keeps them all — the cap above
          // already bounds the count); the per-column value lists below are
          // computed over ALL matches so a downstream `in_list` is complete.
          // Cells are trimmed so `firstRow`/`rows` agree with `columnValues`.
          // Built only on the find_rows path: find_heading returned above and
          // uses neither, so computing them for it was pure wasted iteration.
          //
          // "last" stores the TAIL of the matches rather than the head, so the
          // row the run acts on is always inside `rows` — otherwise a filter
          // matching more than the cap would show a grid that excludes the one
          // row `firstRow` points at.
          const rowLimit = mode === "each" ? matches.length : 100;
          const rows = (
            mode === "last"
              ? matches.slice(-rowLimit)
              : matches.slice(0, rowLimit)
          ).map((m) => {
            const out: Record<string, string> = {};
            for (const [col, key] of keyed) {
              out[key] = getRowCell(m.row, col).trim();
            }
            return out;
          });

          const columnValues: Record<string, string> = {};
          for (const [col, key] of keyed) {
            const seen = new Set<string>();
            const unique: string[] = [];
            for (const m of matches) {
              const v = getRowCell(m.row, col).trim();
              if (v && !seen.has(v)) {
                seen.add(v);
                unique.push(v);
              }
            }
            columnValues[key] = JSON.stringify(unique);
          }

          return {
            ...context,
            [outputKey]: {
              action,
              spreadsheetId,
              sheetName,
              matchCount: matches.length,
              // Every column's sanitized key — stored so the execution grid can
              // render column headers even when zero rows matched.
              columns: keyed.map(([, key]) => key),
              rows,
              columnValues,
              // The matched row this run acts on (sanitized keys), or {} when
              // nothing matched: the topmost in "first", the bottom-most in
              // "last". Lets a downstream node reference a SINGLE value
              // (e.g. `firstRow.Job No`) instead of the columnValues list. The
              // key is mode-independent by design — flipping first↔last must
              // not break a saved `@<...firstRow.X>@` reference. Selecting off
              // `rows` (not `matches`) is safe because the window above is
              // aligned to the same mode.
              firstRow: selectSingleMatch(rows, mode) ?? {},
            },
          };
        } catch (error) {
          throw await toSheetsError(error);
        }
      }

      // Exhaustiveness guard — unreachable for any real action. Both read
      // actions (find_rows AND find_heading) returned from the shared block
      // just above, and every write action returned from its own path earlier:
      // the append paths, color_rows/color_heading, and update_row/update_heading.
      // The legacy read_rows action was removed (find_rows with no conditions
      // reads every row). Reaching here means an action string with no handler
      // — a bug, not user error.
      throw new NonRetriableError(
        `${ERROR_PREFIX}: unsupported action "${action}"`,
      );
    });

    // Apply the multi-match policy OUTSIDE the step — the branded fan-out
    // outcome carries a symbol that would NOT survive the step's JSON
    // checkpoint round-trip.
    let outcome: WorkflowContext | FanOutOutcome | NodeOutcome = result;

    // find_heading branches Found / Not found like find_rows, and reuses its
    // handle ids so switching between the two read actions keeps the wired edges
    // working. It has NO fan-out: acting once per heading is a bigger idea than
    // this action's "search box" UI implies, so it is deliberately left out
    // rather than half-exposed.
    if (action === "find_heading") {
      const { items, ...output } = result[outputKey] as Record<string, unknown>;
      const matchCount =
        typeof output.matchCount === "number" ? output.matchCount : 0;
      // `items` is fan-out fuel, never part of the record — the headings it
      // carries are already in `headings`.
      const recorded = { ...result, [outputKey]: output };

      if (matchCount === 0) {
        // Nothing matched — route Not-found. This bypasses the policy entirely:
        // in "each" mode a 0-match run would otherwise fan out zero children and
        // mark the whole downstream SKIPPED, when Not-found is what should run.
        outcome = routed(recorded, [FIND_ROWS_OUTPUTS.NOT_FOUND]);
      } else {
        const mode = headingMode("all");
        outcome = routeHappy(
          applyMultiMatchPolicy({
            mode: mode === "each" ? "each" : "first",
            maxItems: config.maxFanOutItems,
            items: Array.isArray(items) ? items : [],
            context: recorded,
            outputKey,
            output,
            itemNoun: "heading",
          }),
          FIND_ROWS_OUTPUTS.FOUND,
        );
      }
    }

    if (action === "find_rows") {
      const output = result[outputKey] as Record<string, unknown>;
      const matchCount =
        typeof output.matchCount === "number" ? output.matchCount : 0;

      if (matchCount === 0) {
        // Nothing matched — route the Not-found branch. This bypasses the
        // multi-match policy entirely: in "each" mode a 0-match run would
        // otherwise fan out zero children and mark the whole downstream SKIPPED,
        // when the Not-found branch is exactly what should run.
        outcome = routed(result, [FIND_ROWS_OUTPUTS.NOT_FOUND]);
      } else {
        // `output.rows` already respects the policy ("each" kept every matched
        // row as a fan-out item, cap enforced in-step; other modes store ≤ 100).
        // The SUMMARY recorded for the parent is capped back to 100 rows so a
        // large fan-out can't bloat the run record — the full list still reaches
        // the children via `items`.
        const rows = Array.isArray(output.rows) ? output.rows : [];
        const policyOutcome = applyMultiMatchPolicy({
          mode: config.onMultipleMatches,
          maxItems: config.maxFanOutItems,
          items: rows,
          totalCount: matchCount,
          context: result,
          outputKey,
          output:
            rows.length > 100
              ? { ...output, rows: rows.slice(0, 100) }
              : output,
          itemNoun: "row",
        });
        // ≥1 match → route the Found branch ("each" mode's fan-out passes
        // through untouched).
        outcome = routeHappy(policyOutcome, FIND_ROWS_OUTPUTS.FOUND);
      }
    }

    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );
    return outcome;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
