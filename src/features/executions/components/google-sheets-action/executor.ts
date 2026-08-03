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
  cellFormatRequests,
  ensureGridRows,
  getSheetGrid,
  mergedDataRows,
  nextFreeSheetRow,
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
  type MultiMatchConfig,
  readFanOutSeed,
  selectSingleMatch,
} from "@/lib/multi-match";
import {
  getRowCell,
  matchRows,
  type RowMatch,
  type RowMatchCondition,
} from "@/lib/row-match";
import {
  hasActiveRowCondition,
  usesMergedColumn,
} from "@/lib/row-match-operators";
import { stripTextForcing, toSheetsCellValue } from "@/lib/sheet-cells";
import { ANCHOR_ROW_KEY, sanitizeHeaderKey } from "@/lib/sheet-headers";
import {
  buildRowByHeader,
  buildSheetRow,
  findBlankRequired,
} from "@/lib/sheet-row";
import {
  type CellFormat,
  DEFAULT_MERGE_MODE,
  DEFAULT_STYLE_MATCH_MODE,
  isNoOpStyle,
  type MergeMode,
  resolveColumnBand,
  type StyleMatchMode,
} from "@/lib/sheet-style";
import { renderTemplate } from "@/lib/templating";
import {
  FIND_ROWS_OUTPUTS,
  LEGACY_MAIN_OUTPUTS,
  STYLE_OUTPUTS,
  UPDATE_ROW_OUTPUTS,
} from "./handles";

type SheetsAction = "append_row" | "find_rows" | "update_row" | "style_cells";

/**
 * One row a `style_cells` run will touch, as settled by its PLAN step.
 *
 * `mergeSpan` is carried per row rather than derived once, because the columns a
 * merge may cover are a property of that row's existing merge — not of the tab's
 * header width. See `cellFormatRequests`.
 */
type StyleTarget = {
  /** 0-based grid row: the header is 0, so data row i is i + 1. */
  gridRow0: number;
  mergeSpan: { startColumnIndex: number; endColumnIndex: number };
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
  // append_row + bottom only: leave the first free row EMPTY as a separator and
  // write the new row one lower. Nothing blank is ever sent to Sheets.
  blankRowAbove?: boolean;
  // AND-ed row filter, shared by find_rows (which returns the matches),
  // update_row (which writes them), style_cells (which restyles them) and a
  // non-bottom append (for which they are the GROUP the new row joins). Every
  // write case requires at least one. A condition may name MERGED_ROW_COLUMN to
  // select rows whose cells are joined.
  conditions?: RowMatchCondition[];
  // NOTE: the multi-match keys (onMultipleMatches / maxFanOutItems /
  // onItemFailure) are NOT listed here — they arrive via the
  // `& MultiMatchConfig` intersection below, so this type can never drift from
  // the schema fragment that defines them.
  // style_cells + append_row: the formatting to apply. Every property is
  // optional and unset means "leave it alone" — see `cellFormatSchema`.
  cellFormat?: CellFormat;
  // style_cells + append_row: merge the band into one cell, unmerge it, or leave
  // merging alone (the default).
  mergeMode?: MergeMode;
  // style_cells only: restrict the styled band to these headers. Absent/empty ⇒
  // the tab's full used width.
  styleColumns?: string[];
  // append_row only: whether the inline style block applies at all.
  styleAppendedRow?: boolean;
  // append_row + mergeMode "merge" ONLY: the single value the merged row holds.
  // A merged row is one cell, so it takes text rather than a column mapping —
  // see `renderMergedText`.
  mergedText?: string;
  // style_cells only: restyle just the topmost matched row ("first"), just the
  // bottom-most ("last"), or every matched row ("all", the default). Its own key
  // — styling does not use the shared `onMultipleMatches` fan-out policy.
  onMultipleStyleMatches?: StyleMatchMode;
} & MultiMatchConfig;

const ERROR_PREFIX = "Google Sheets Action";

/**
 * Hard ceiling on how many rows one `style_cells` run may restyle. The action
 * emits one `repeatCell` per row and has no per-node cap in its dialog (unlike
 * the fan-out actions, which have "Max rows"), so this is what stops a filter
 * that matches an entire tab from building a batchUpdate too large to send.
 * Matches MAX_FAN_OUT_ITEMS_LIMIT — the same "one run shouldn't touch more than
 * this" ceiling the fan-out cap tops out at.
 */
const MAX_STYLED_ROWS = MAX_FAN_OUT_ITEMS_LIMIT;

/**
 * How a row's values are interpreted on write.
 *
 * A DATA row uses `USER_ENTERED`, so numbers and dates parse as a user typing
 * them would expect (padded ids are protected separately, by `forceTextIds`).
 *
 * A MERGED row is `RAW`: it is a label, never a value, so it must land in the
 * cell exactly as written. Under `USER_ENTERED` a title of "0009" would be
 * stored as the number 9 (the verified failure `sheet-cells.ts` documents),
 * "March 2026" would become a date, and anything starting "=" would be evaluated
 * as a formula — a section title showing #NAME? instead of its text. `RAW` is a
 * better fix here than the force-text apostrophe the row builder uses, because
 * it leaves no write artifact to strip back off when the row is read again.
 */
const MERGE_SAFE_VALUE_INPUT = (isMerging: boolean) =>
  isMerging ? "RAW" : "USER_ENTERED";

/**
 * The key a merged row's text is stored under in a `rowsByHeader` row: the tab's
 * FIRST column.
 *
 * `readSheetTable` keys a blank header as `colN`, so an empty A1 must resolve to
 * `col1` rather than to "" — which would match no key at all and silently make
 * every merged row read as empty text.
 */
function firstColumnKey(headers: string[]): string {
  return (headers[0] ?? "").trim() || "col1";
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
  const isAppending = action === "append_row";
  // Appending only: where the row lands. The two "under_*" positions run the
  // group-insert path below; "bottom" (the default) is a plain append.
  const position: RowPosition = config.position ?? "bottom";
  /**
   * Is this append also styling the row it writes?
   *
   * `styleAppendedRow` is the section's on/off switch, kept separate from
   * `cellFormat` so turning it off preserves the choices inside it — but the
   * switch alone isn't enough: a format that sets nothing and merges nothing
   * would cost an API call to write no change.
   */
  const stylingAppendedRow =
    isAppending &&
    config.styleAppendedRow === true &&
    !isNoOpStyle(config.cellFormat, config.mergeMode);
  // An appended row that gets MERGED is a label, not data, so its value must be
  // written RAW — see MERGE_SAFE_VALUE_INPUT.
  const mergingAppendedRow = stylingAppendedRow && config.mergeMode === "merge";
  /**
   * Whether to apply the force-as-text apostrophe when building the row.
   *
   * ⚠️ MUST track `mergingAppendedRow` inversely. The apostrophe
   * (`toSheetsCellText`) is Sheets' *USER_ENTERED* escape — it is consumed on
   * write only under that mode. A merged row is written `RAW`, where nothing is
   * consumed, so forcing the text there stores a literal `'0009` in the cell
   * while this node's own `rowByHeader` output reports the clean `0009`.
   *
   * The two mechanisms solve the SAME problem — a padded id surviving the write
   * — and are mutually exclusive: RAW already preserves the string verbatim, so
   * it needs no escape at all.
   */
  const forceTextIds = !mergingAppendedRow;

  /**
   * The single cell a MERGED appended row holds, rendered against `rowContext`
   * (which carries the anchor row for a non-bottom placement, so the text can
   * name the group it sits under).
   *
   * ⚠️ A merged row is ONE cell, not a mapped row. Sheets' MERGE_ALL keeps only
   * the top-left value and DISCARDS the rest, so building this row from
   * `columnMappings` would throw away every column but the first — and if the
   * user mapped anything OTHER than the first column, the merged cell would come
   * out EMPTY and the row would render blank. So a merging append takes one
   * `mergedText` and writes a one-cell row.
   *
   * Rejects an empty result loudly rather than merging a blank band: the config
   * schema already requires the text, so an empty render means the template's
   * upstream value was missing, and silently writing an unlabelled merged row
   * would hide that.
   */
  /**
   * Refuse to merge on a tab too narrow for it.
   *
   * Sheets rejects a single-cell merge, so on a one-column tab the row would be
   * written, no merge emitted, and the run would still report `merged: true` —
   * leaving a row indistinguishable from ordinary data that no merged-row filter
   * could ever find again. Both append plan steps call this; it was previously
   * the same four-line message written out twice.
   */
  const assertMergeable = (headers: string[]): void => {
    if (!mergingAppendedRow || headers.length >= 2) return;
    throw new NonRetriableError(
      `${ERROR_PREFIX}: "${sheetName}" has only one column, so this row ` +
        `cannot be merged — and an unmerged row is indistinguishable from ` +
        `an ordinary one, so nothing would be able to find it later. ` +
        `Add a second column, or turn merging off.`,
    );
  };

  const renderMergedText = (rowContext: WorkflowContext): string => {
    const text = renderTemplate(config.mergedText ?? "", rowContext).trim();
    if (!text) {
      throw new NonRetriableError(
        `${ERROR_PREFIX}: the merged row's text is empty — check the value it is built from`,
      );
    }
    return text;
  };
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
          // A merged row carries its TEXT where a mapped row carries its
          // header-keyed columns — the same pair the parent emitted, so a
          // downstream reference resolves identically in every mode.
          rowByHeader: item.row ?? {},
          ...(typeof item.mergedText === "string"
            ? { mergedText: item.mergedText, merged: true }
            : {}),
          anchorRow: item.anchorRow ?? {},
          ...lineage,
        },
      };
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

  /**
   * The tab's MERGED rows — and the tab's numeric id, which the same metadata
   * response already carries.
   *
   * THE single place a merge lookup happens, memoised for the run because it is
   * the expensive read (`includeMerges`) and every caller wants the same answer.
   *
   * ⚠️ Two things need it, not one. A filter using `MERGED_ROW_COLUMN` obviously
   * does — but so does the EXCLUSION rule that keeps an ordinary filter off
   * section titles (`matchRowsScoped`), which is the common case. So a run that
   * matches at least one row generally pays for this, and only a zero-match run
   * — the steady state of a polling workflow — avoids it entirely. A workbook of
   * report tabs can carry thousands of merge objects, which is why it is still
   * lazy rather than fetched up front.
   */
  let mergesCache: Promise<{
    /** data row → the width it is actually merged across. */
    mergedRows: Map<number, number>;
    sheetId: number;
  }> | null = null;
  const readMergedRows = () => {
    mergesCache ??= (async () => {
      const grid = await getSheetGrid({
        accessToken,
        spreadsheetId,
        sheetName,
        includeMerges: true,
      });
      return {
        mergedRows: mergedDataRows(grid.merges),
        sheetId: grid.sheetId,
      };
    })();
    return mergesCache;
  };

  /**
   * The tab's numeric id, which `batchUpdate` addresses it by.
   *
   * Reuses the merge read when a filter already paid for it, and otherwise makes
   * the CHEAP metadata call — `getSheetGrid` omits merges by default, and a
   * workbook of report tabs can carry thousands of merge objects that a run
   * needing only the id would be fetching for nothing.
   */
  const resolveSheetId = async (): Promise<number> => {
    if (mergesCache) return (await mergesCache).sheetId;
    const grid = await getSheetGrid({ accessToken, spreadsheetId, sheetName });
    return grid.sheetId;
  };

  /**
   * The options `matchRows` needs for THIS node's filter.
   *
   * Every filtering branch funnels through here, so "does this filter need the
   * tab's merge ranges, and did it get them?" is answered in exactly one place.
   * That matters because a `MERGED_ROW_COLUMN` condition FAILS CLOSED: a branch
   * that forgot to await the merge read would quietly match nothing rather than
   * erroring, and the bug would look like "my filter stopped working".
   *
   * Returns an empty bag when no active condition asks about merging — the
   * EXCLUSION half of the rule still needs the merge map, but it applies after
   * the match, so `matchRowsScoped` fetches it there instead.
   */
  const rowMatchOptionsFor = async (
    conditions: RowMatchCondition[] | undefined,
    table: Awaited<ReturnType<typeof readSheetTable>>,
  ) => {
    if (!usesMergedColumn(conditions)) return {};
    const { mergedRows } = await readMergedRows();
    return { mergedRows, firstColumn: firstColumnKey(table.headers) };
  };

  /**
   * Run this node's filter — THE one entry point every filtering branch uses.
   *
   * A filter is one of exactly two things, decided by whether any active
   * condition names `MERGED_ROW_COLUMN`:
   *
   *   names it     ⇒ matches ONLY merged rows (`evaluateRowCondition` rejects a
   *                  non-merged row before the operator is even consulted).
   *   doesn't      ⇒ matches only ORDINARY rows; merged ones are excluded here.
   *
   * That second half is a SAFETY rule, and it is why this function exists rather
   * than callers using `matchRows` directly. A section title is structurally an
   * ordinary row — its text sits in column A and its other cells read as empty —
   * so a filter written against your data columns hits it by accident. `Status
   * is_empty` would match every section title on the tab, and on `update_row`
   * that overwrites them. Asking for a merged row is deliberate; getting one is
   * never an accident.
   *
   * The merge lookup is paid for only when it can change the answer: never on a
   * zero-match run (the steady state of a polling workflow), and never twice
   * (`readMergedRows` is memoised for the run).
   */
  const matchRowsScoped = async (
    conditions: RowMatchCondition[] | undefined,
    table: Awaited<ReturnType<typeof readSheetTable>>,
  ): Promise<RowMatch[]> => {
    const matches = matchRows(
      table.rowsByHeader,
      conditions ?? [],
      context,
      await rowMatchOptionsFor(conditions, table),
    );
    // Already narrowed to merged rows by the matcher itself.
    if (matches.length === 0 || usesMergedColumn(conditions)) return matches;
    const { mergedRows } = await readMergedRows();
    return matches.filter((m) => !mergedRows.has(m.index));
  };

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
   * Apply this append's inline style to the row(s) it just wrote — the format,
   * and the merge that turns a written row into a section title. Any blank
   * separator row added alongside is forced white in the SAME batchUpdate, so
   * "a styled row with a gap above it" costs one format call rather than two.
   *
   * Runs AFTER the value write — the text must exist before the cells are merged,
   * or the merge would swallow an empty cell and the write would then land on a
   * merged range.
   *
   * `rowNumbers` are 1-based sheet rows; each maps to grid row n − 1.
   */
  const styleAppendedRows = async (
    styledRows: number[],
    blankRows: number[],
    columnCount: number,
  ): Promise<void> => {
    if (styledRows.length === 0 || columnCount === 0) return;
    await applyFormatRequests(
      "google-sheets-style-appended-rows",
      (sheetId) => [
        ...styledRows.flatMap((n) =>
          cellFormatRequests({
            sheetId,
            gridRow0: n - 1,
            startColumnIndex: 0,
            endColumnIndex: columnCount,
            format: config.cellFormat,
            merge: config.mergeMode,
          }),
        ),
        ...blankRows.map((n) => whiteRowRequest(sheetId, n - 1, columnCount)),
      ],
    );
  };

  try {
    // style_cells formats the rows a filter selects, and optionally merges or
    // unmerges them. It lives outside the shared step switch below because it is
    // the one action that touches FORMAT rather than values, and — like the
    // append and update paths — it splits its READ from its WRITE across two
    // Inngest steps.
    //
    // That split is load-bearing whenever merging is involved. Pure formatting
    // would be safe in one step (it changes no cell VALUE, so a replayed read
    // re-matches the same rows), but `mergeCells` DISCARDS every cell but the
    // top-left. So after a merge lands, a retry of a single combined step would
    // re-read a tab where the matched rows no longer satisfy any condition
    // written against a non-first column, find nothing, and route the No-match
    // branch even though the styling had succeeded. Memoizing the plan means the
    // retry replays the rows it already chose.
    if (action === "style_cells") {
      // An empty filter makes matchRows vacuously true, so it would restyle
      // EVERY row in the tab. The config schema rejects this too; re-checked
      // here because the executor is what writes.
      if (!hasActiveRowCondition(config.conditions)) {
        throw new NonRetriableError(
          `${ERROR_PREFIX}: styling needs at least one filter condition — ` +
            `an empty filter would restyle every row in "${sheetName}"`,
        );
      }

      const mergeMode = config.mergeMode ?? DEFAULT_MERGE_MODE;
      // A run that sets no property and changes no merge would read the tab and
      // write nothing. Every style property starts out as "leave as is", so this
      // is easy to reach by accident — fail loudly rather than reporting a
      // successful style that did nothing.
      if (isNoOpStyle(config.cellFormat, mergeMode)) {
        throw new NonRetriableError(
          `${ERROR_PREFIX}: this step sets no style property and no merge ` +
            `option, so it would change nothing`,
        );
      }

      // STEP 1 — read, match, and settle exactly which rows get styled and over
      // which columns. Memoized, so the write below replays this plan rather
      // than re-reading a tab its own landed merge already collapsed.
      const planned = await step.run("google-sheets-style-plan", async () => {
        try {
          const table = await readSheetTable({
            accessToken,
            spreadsheetId,
            sheetName,
          });
          // The header row defines how wide the band goes, so without one there
          // is nothing to style across. Guarded explicitly because with zero
          // headers every row reads as an empty object — an `is_empty`
          // condition would "match" every row and then style a zero-width range.
          if (table.headers.length === 0) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: the sheet has no header row (row 1) to style up to`,
            );
          }

          // Which COLUMNS the band spans. Absent/empty ⇒ the tab's full used
          // width, which is what colouring a row has always meant.
          //
          // `resolveColumnBand` is shared with the dialog, which warns about the
          // same two problems live. Both were previously derived separately and
          // had already diverged on whether header names matched
          // case-insensitively — so the dialog could pass a selection the
          // executor then rejected mid-run.
          const band = resolveColumnBand(
            table.headers,
            config.styleColumns ?? [],
          );
          const { startColumnIndex, endColumnIndex } = band;
          // Rejected rather than ignored: silently styling a wider band than
          // asked for is the kind of "it did something else" failure a user
          // cannot debug from the sheet.
          if (band.unknown.length > 0) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: column "${band.unknown[0]}" is not on ` +
                `"${sheetName}" — its columns are ` +
                `${table.headers.filter(Boolean).join(", ")}`,
            );
          }
          if (band.gap.length > 0) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: the chosen columns aren't next to each other — ` +
                `styling them would also cover ${band.gap.join(", ")}, because ` +
                `a sheet range can't skip a column. Either include those, or ` +
                `narrow the selection.`,
            );
          }

          // Same header-keying as find_rows, so the execution grid renders these
          // rows exactly like a find_rows result.
          const keyed = table.headers
            .map((c) => c.trim())
            .filter((c) => c.length > 0)
            .map((col) => [col, sanitizeHeaderKey(col)] as const);

          // A MERGED_ROW_COLUMN condition needs the tab's merge ranges; without
          // them it fails closed and matches nothing. Without one, section
          // titles are EXCLUDED — see `matchRowsScoped`.
          const matched = await matchRowsScoped(config.conditions, table);

          // "first" styles only the topmost matched row and "last" only the
          // bottom-most (matches are already in sheet order); "all" (the
          // default) styles every matched row. Slicing HERE means everything
          // below — the summary, the cap check, and the write — sees exactly the
          // rows this run will touch. `.slice` is empty-safe, so a zero-match
          // run stays a clean no-op in every mode.
          const mode =
            config.onMultipleStyleMatches ?? DEFAULT_STYLE_MATCH_MODE;
          const entries =
            mode === "first"
              ? matched.slice(0, 1)
              : mode === "last"
                ? matched.slice(-1)
                : matched;

          const summary = {
            // How many rows matched the filter — ALL of them, even when only one
            // is styled. Same meaning as find_rows/update_row's matchCount, so a
            // downstream branch on "how many matched" reads the true count in
            // every mode.
            matchCount: matched.length,
            // How many this run actually styled: every match in "all", exactly
            // one in "first"/"last". `rows`/`rowIndexes` below describe THESE.
            styledCount: entries.length,
            mergeMode,
            // The format this run applied, echoed so the run view can show the
            // colour it painted rather than only naming it — the one thing a
            // plain text grid cannot say about a styling run.
            cellFormat: config.cellFormat ?? {},
            // Stored even when nothing matched, so the grid can still render
            // column headers.
            columns: keyed.map(([, key]) => key),
            // Capped like find_rows' `rows`, so styling a huge tab can't bloat
            // the run record.
            rows: entries.slice(0, 100).map(({ row }) => {
              const out: Record<string, string> = {};
              for (const [col, key] of keyed) {
                out[key] = getRowCell(row, col).trim();
              }
              return out;
            }),
            // Sheet row numbers (1-based, past the header).
            rowIndexes: entries.slice(0, 100).map(({ index }) => index + 2),
          };

          // Nothing matched ⇒ nothing to write. Returned BEFORE the grid lookup
          // below, so a run that styles nothing — the steady state of a polling
          // workflow — costs one read instead of two.
          if (entries.length === 0) {
            return {
              summary: { ...summary, merged: false },
              sheetId: 0,
              targets: [] as StyleTarget[],
              startColumnIndex,
              endColumnIndex,
            };
          }

          // Every other multi-row path in this node caps how much one run may
          // touch; this one has no per-node cap in its UI, so it enforces a hard
          // ceiling. Checked BEFORE the write: one repeatCell per styled row
          // means a filter matching an entire tab would otherwise build a
          // multi-megabyte batchUpdate that Sheets rejects or times out on,
          // after the user had already committed to it.
          if (entries.length > MAX_STYLED_ROWS) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: ${entries.length} rows match this filter, ` +
                `which is more than this step styles in one run ` +
                `(${MAX_STYLED_ROWS}). Narrow the conditions.`,
            );
          }

          // batchUpdate addresses the tab by numeric id, not name. A filter that
          // asked about merging already fetched it, so this reuses that response
          // rather than paying for a second metadata read.
          const sheetId = await resolveSheetId();

          /**
           * Which columns THIS row's merge/unmerge covers.
           *
           * Sheets rejects a merge or unmerge range that PARTIALLY INTERSECTS an
           * existing merge, and a row's real merge width is a fact about the
           * sheet rather than about today's header row — a row merged when the
           * tab had 3 columns stays 3 wide after a 4th is added. So an
           * already-merged row is re-merged (or unmerged) at the width it
           * actually HAS, never at the width the header row now implies.
           *
           * A row that is not merged: merging uses the styled band, and
           * unmerging is skipped entirely (a zero-width span, which
           * `cellFormatRequests` drops) — there is nothing to take apart.
           */
          const existingWidths =
            mergeMode === "none" ? null : (await readMergedRows()).mergedRows;
          const targets: StyleTarget[] = entries.map(({ index }) => {
            const existing = existingWidths?.get(index);
            const span =
              existing !== undefined
                ? { startColumnIndex: 0, endColumnIndex: existing }
                : mergeMode === "unmerge"
                  ? { startColumnIndex: 0, endColumnIndex: 0 }
                  : { startColumnIndex, endColumnIndex };
            return { gridRow0: index + 1, mergeSpan: span };
          });

          // The span rides on the plan so the write step uses the columns this
          // plan resolved against the live header row, not a re-derivation.
          //
          // `merged` reports what the run WILL actually do, not what was asked:
          // `cellFormatRequests` drops a merge over a band under 2 columns wide,
          // so a single-column selection would otherwise claim a merge that was
          // never sent. Derived from the spans settled just above.
          return {
            summary: {
              ...summary,
              merged:
                mergeMode === "merge" &&
                targets.some(
                  (t) =>
                    t.mergeSpan.endColumnIndex - t.mergeSpan.startColumnIndex >
                    1,
                ),
            },
            sheetId,
            targets,
            startColumnIndex,
            endColumnIndex,
          };
        } catch (error) {
          throw await toSheetsError(error);
        }
      });

      // STEP 2 — one batchUpdate for every planned row. Rebuilt from the
      // memoized plan (rather than carrying the requests across the checkpoint)
      // so a large run doesn't haul a multi-megabyte payload through Inngest.
      // `cellFormatRequests` builds the `fields` mask from only the properties
      // that were set — which is what leaves everything else on these cells
      // untouched — and throws on a malformed colour while the requests are
      // built, i.e. before anything is written.
      if (planned.targets.length > 0) {
        await step.run("google-sheets-style-write", async () => {
          try {
            const requests = planned.targets.flatMap((t) =>
              cellFormatRequests({
                sheetId: planned.sheetId,
                gridRow0: t.gridRow0,
                startColumnIndex: planned.startColumnIndex,
                endColumnIndex: planned.endColumnIndex,
                format: config.cellFormat,
                merge: mergeMode,
                mergeSpan: t.mergeSpan,
              }),
            );
            // Rows matched but there is nothing to send — e.g. an unmerge over
            // rows that turned out not to be merged. Posting an empty request
            // list would be a round-trip that changes nothing and still reports
            // success.
            if (requests.length === 0) return null;

            await sheetsWrite(
              sheetsBatchUpdateUrl(spreadsheetId),
              {
                headers: sheetsAuthHeaders(accessToken),
                json: { requests },
              },
              // Sets each cell's FINAL format on fixed cells, and re-merging an
              // identical range is accepted as a no-op, so a retry rewrites to
              // the same result rather than compounding.
              { idempotent: true },
            );
            return null;
          } catch (error) {
            throw await toSheetsError(error);
          }
        });
      }

      const styled = planned.summary;
      await publish(
        nodeStatusChannel(userId).status({ nodeId, status: "success" }),
      );

      const output = {
        ...context,
        [outputKey]: {
          action,
          spreadsheetId,
          sheetName,
          ...styled,
        },
      };
      // Nothing styled ⇒ route the No-match branch so the downstream that
      // handles "no row to flag" runs. Keyed on styledCount, not matchCount:
      // the branch is about whether a row was STYLED.
      return styled.styledCount === 0
        ? routed(output, [STYLE_OUTPUTS.NO_MATCH])
        : routeHappy(output, STYLE_OUTPUTS.STYLED);
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

            assertMergeable(table.headers);

            // The filter picks the GROUP the new row joins. Section titles are
            // excluded unless asked for, so one is never mistaken for the
            // group's last row — which would drop the new row directly under a
            // title instead of under its data.
            const matches = await matchRowsScoped(config.conditions, table);
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

              // A merged row is ONE cell — no mapping, no serial, no required
              // columns. `@<anchorRow.…>@` still resolves, so the text can name
              // the group it is placed under. See `renderMergedText`.
              if (mergingAppendedRow) {
                const mergedText = renderMergedText({
                  ...context,
                  [ANCHOR_ROW_KEY]: anchorRow,
                });
                return {
                  anchorIdx,
                  row: [mergedText],
                  anchorRow,
                  mergedText,
                  rowByHeader: {} as Record<string, string>,
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
                forceTextIds,
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
                // Kept on both shapes so `built` stays ONE type; only a merged
                // row ever carries a value here.
                mergedText: "",
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
                valueInputOption: MERGE_SAFE_VALUE_INPUT(mergingAppendedRow),
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

      if (stylingAppendedRow) {
        // Style (and optionally merge) each inserted row. The insert used
        // `inheritFromBefore`, so without this the row would wear the group's
        // banding.
        await styleAppendedRows(
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
      const items = placed.rows.map((r) => ({
        row: r.rowByHeader,
        rowIndex: r.rowIndex,
        anchorRow: r.anchorRow,
        // A merged row carries its TEXT where a mapped row carries its columns.
        ...(mergingAppendedRow ? { mergedText: r.mergedText } : {}),
      }));
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
        rowByHeader: first.rowByHeader,
        anchorRow: first.anchorRow,
        // How wide the styled band ended up, when this append styled the row it
        // wrote — the tab's header width at write time.
        ...(stylingAppendedRow
          ? { styledColumns: placed.columnCount, merged: mergingAppendedRow }
          : {}),
        ...(mergingAppendedRow ? { mergedText: first.mergedText } : {}),
      };
      // Only "each_row" writes more than one row, and only then is the list
      // worth recording (in "group" mode `rowByHeader` already IS the one row).
      // Capped like find_rows' `rows`, so a large fan-out can't bloat the run
      // record — children still get the full list via `items`.
      // The row numbers ride alongside so the run view can say WHERE each added
      // row landed, which is the whole question this action answers.
      if (insertUnder === "each_row") {
        // A merged row has no columns to grid, so it is recorded under a single
        // "text" key — the run view then renders one readable cell per inserted
        // row instead of an empty one.
        output.insertedRows = placed.rows
          .slice(0, 100)
          .map((r) =>
            mergingAppendedRow ? { text: r.mergedText } : r.rowByHeader,
          );
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
              config,
              // This append's mode is implied by `position`, not chosen — an
              // "under each match" insert always fans out.
              mode: "each",
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
    if (action === "append_row" && (hasMappings || !range)) {
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
              `${ERROR_PREFIX}: the sheet has no header row (row 1) to map columns to`,
            );
          }
          assertMergeable(table.headers);

          // A merged row is ONE cell of text, so it uses neither the column
          // mapping, the serial feature, nor the required-column rule — see
          // `renderMergedText`.
          const mergedText = mergingAppendedRow
            ? renderMergedText(context)
            : "";
          const newRow = mergingAppendedRow
            ? [mergedText]
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
                // zeros. OFF when the row is being merged, which writes RAW and
                // therefore needs no escape (see `forceTextIds`).
                forceTextIds,
              });

          // Enforce required columns after the row is built (a serial cell is
          // always populated, so it never trips this).
          const blankRequired = mergingAppendedRow
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
            mergedText,
            // A merged row has no columns to key, so it reports its TEXT
            // instead — see the output shape below.
            rowByHeader: mergingAppendedRow
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
                valueInputOption: MERGE_SAFE_VALUE_INPUT(mergingAppendedRow),
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
      // `blankRowAbove` separator (always blank), and the placed row itself when
      // the node has no column mappings (a deliberately blank append). Both can
      // otherwise show the sheet's alternating-row banding. A mapped row that
      // renders empty is a data event, not a spacer — left banded.
      const blanks: number[] = [];
      if (config.blankRowAbove) blanks.push(planned.rowIndex - 1);
      if (stylingAppendedRow) {
        // One batchUpdate: style (and optionally merge) the row it wrote, and
        // clear the separator above it.
        await styleAppendedRows(
          [planned.rowIndex],
          blanks,
          planned.columnCount,
        );
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
          // The header-keyed columns, so downstream nodes can pick them
          // (force-text apostrophe + header dots stripped). A merged row has no
          // columns — it reports `mergedText` instead.
          rowByHeader: planned.rowByHeader,
          // How wide the styled band ended up, when this append styled the row
          // it wrote.
          ...(stylingAppendedRow
            ? { styledColumns: planned.columnCount, merged: mergingAppendedRow }
            : {}),
          ...(mergingAppendedRow ? { mergedText: planned.mergedText } : {}),
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

          // Same row-matching as find_rows: one editor, one matcher. A merged
          // condition reaches section titles deliberately; WITHOUT one they are
          // excluded, so a filter written against your data columns can never
          // overwrite a title by accident (`Status is_empty` matches every one
          // of them — their non-first cells read as empty). See
          // `matchRowsScoped`.
          const matchedIndexes = (
            await matchRowsScoped(config.conditions, table)
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
                // A filter that targets MERGED rows is renaming section titles,
                // which are labels rather than values — so they get the same RAW
                // treatment an appended merged row does. Under USER_ENTERED a
                // title of "March 2026" would be stored as a date and one
                // starting "=" evaluated as a formula. An ordinary data update
                // keeps USER_ENTERED so numbers and dates parse as a user typing
                // them would expect.
                valueInputOption: MERGE_SAFE_VALUE_INPUT(
                  usesMergedColumn(config.conditions),
                ),
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
        config,
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

      if (action === "find_rows") {
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

          // A merged row is an ordinary row to this filter unless the filter
          // says otherwise — a MERGED_ROW_COLUMN condition is how you reach one.
          // Membership is decided by the tab's real MERGE ranges and only by
          // them, so a data row that merely looks like a section title is never
          // wrongly hidden, and a real one carrying a stray cell is never
          // wrongly returned.
          //
          // ⚠️ A merged condition can NARROW to merged rows but can never
          // EXCLUDE them: the check fails closed, so a non-merged row is
          // rejected before the operator is even consulted. `__merged_row__
          // not_contains X` therefore returns merged rows whose text lacks X —
          // never a data row. There is deliberately no "not merged" filter;
          // ordinary column conditions already ignore the distinction.
          //
          // The merge metadata is fetched ONLY when it can change the answer —
          // see `matchRowsScoped`.
          const matches = await matchRowsScoped(config.conditions, table);

          // Multi-match policy is applied OUTSIDE this step (see below) — but
          // "each" needs every match as a fan-out item, so its cap is enforced
          // HERE on the true count (silently truncating children would be worse
          // than failing) before hauling the rows across the step checkpoint.
          const mode = config.onMultipleMatches ?? "first";
          if (mode === "each") {
            assertFanOutCap(matches.length, config.maxFanOutItems, "row");
          }

          // Stored rows are capped ("each" keeps them all — the cap above
          // already bounds the count); the per-column value lists below are
          // computed over ALL matches so a downstream `in_list` is complete.
          // Cells are trimmed so `firstRow`/`rows` agree with `columnValues`.
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

      // Exhaustiveness guard — unreachable for any real action. find_rows
      // returned from the block just above, and every write action returned
      // from its own path earlier: the append paths, style_cells, and
      // update_row. The legacy read_rows action was removed (find_rows with no
      // conditions reads every row). Reaching here means an action string with
      // no handler — a bug, not user error.
      throw new NonRetriableError(
        `${ERROR_PREFIX}: unsupported action "${action}"`,
      );
    });

    // Apply the multi-match policy OUTSIDE the step — the branded fan-out
    // outcome carries a symbol that would NOT survive the step's JSON
    // checkpoint round-trip.
    let outcome: WorkflowContext | FanOutOutcome | NodeOutcome = result;

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
          config,
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
