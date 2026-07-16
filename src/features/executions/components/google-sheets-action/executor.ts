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
  getSheetGrid,
  readSheetTable,
  sheetRange,
  sheetsAuthHeaders,
  sheetsBatchUpdateUrl,
  sheetsValuesBatchUpdateUrl,
  sheetsValuesUrl,
  sheetsWrite,
  toSheetsError,
} from "@/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { type MultiMatchMode, readFanOutSeed } from "@/lib/multi-match";
import { getRowCell, matchRows, type RowMatchCondition } from "@/lib/row-match";
import { hasActiveRowCondition } from "@/lib/row-match-operators";
import { coerceCellValue } from "@/lib/sheet-cells";
import { ANCHOR_ROW_KEY, sanitizeHeaderKey } from "@/lib/sheet-headers";
import {
  buildRowByHeader,
  buildSheetRow,
  findBlankRequired,
} from "@/lib/sheet-row";
import { renderTemplate } from "@/lib/templating";
import {
  FIND_ROWS_OUTPUTS,
  LEGACY_MAIN_OUTPUTS,
  UPDATE_ROW_OUTPUTS,
} from "./handles";

type SheetsAction =
  | "append_row"
  | "find_rows"
  | "update_row"
  | "insert_row_adjacent";

type GoogleSheetsActionData = {
  action?: SheetsAction;
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
  // "match the columns" mapping: column header -> template string.
  columnMappings?: Record<string, string>;
  // Headers that may not be blank on the row-creating actions (accessory "may
  // be blank" off).
  requiredColumns?: string[];
  // AND-ed row filter, shared by find_rows (which returns the matches),
  // update_row (which writes them) and insert_row_adjacent (for which they are
  // the GROUP the new row joins). Both write actions require at least one.
  conditions?: RowMatchCondition[];
  // Multi-match policy for find_rows / update_row (see src/lib/multi-match.ts).
  // insert_row_adjacent has none — for it, several matches are a GROUP, not
  // candidates to choose between, so `insertUnder` decides where the row lands
  // instead. It still honours the fan-out cap in "each_row" mode.
  onMultipleMatches?: MultiMatchMode;
  maxFanOutItems?: number;
  // insert_row_adjacent: separate a brand-new group from the one above it with
  // a blank row (only on the no-match path, and only if the tab has data).
  blankSeparators?: boolean;
  // insert_row_adjacent: ONE row below the whole group ("group", the default),
  // or one row below EVERY matching row ("each_row", which then fans out one
  // child run per inserted row, capped by maxFanOutItems).
  insertUnder?: "group" | "each_row";
};

const ERROR_PREFIX = "Google Sheets Action";

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

    if (action === "insert_row_adjacent") {
      // The parent already inserted every row (one per matched row) — a child
      // must not insert again. Its item carries the row it handled, where that
      // row landed, and the row it was placed under, so siblings are
      // distinguishable even when their contents are identical.
      return {
        ...context,
        [outputKey]: {
          action,
          spreadsheetId,
          sheetName,
          matchCount: 1,
          insertedUnderGroup: true,
          blankSeparatorAdded: false,
          rowIndex: item.rowIndex,
          rowByHeader: item.row ?? {},
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

  // Range is only needed for the legacy values-based append.
  // find_rows reads the whole tab and needs neither a mapping nor a range.
  if (action !== "find_rows" && !hasMappings && !range) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      `${ERROR_PREFIX}: a column mapping or a range is required`,
    );
  }

  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  try {
    // insert_row_adjacent and update_row live OUTSIDE the single-step switch
    // below because each splits a read/plan from its write across two Inngest
    // steps: insert_row_adjacent because a row must be created before it can be
    // filled; update_row so a retry of its idempotent write replays the memoized
    // target ranges instead of re-reading a sheet the landed write already
    // mutated (which could re-match a DIFFERENT row). The paired `step.run`s are
    // what make both safe.
    if (action === "insert_row_adjacent") {
      // The filter is what picks the group. With none active, matchRows is
      // vacuously true — every row "matches", so the group is the whole tab and
      // the insert degenerates into an append. The schema rejects that; this is
      // the executor's own check, because the executor is what writes.
      if (!hasActiveRowCondition(config.conditions)) {
        throw new NonRetriableError(
          `${ERROR_PREFIX}: inserting a row needs at least one filter condition — ` +
            `it selects the group the new row joins in "${sheetName}"`,
        );
      }

      const insertUnder = config.insertUnder ?? "group";

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

            const matches = matchRows(
              table.rowsByHeader,
              config.conditions ?? [],
              context,
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
            // ones already in the tab. A padded serial is force-text ("'0004")
            // and `parseInt` chokes on the apostrophe, so the copy fed back for
            // the max() computation has it stripped.
            const seenRows = [...table.rows];
            const built = anchorIndexes.map((anchorIdx) => {
              // Empty mappings ⇒ pure sanitized header keys, no serial-quote
              // stripping: this is an EXISTING row, read as-is.
              const anchorRow =
                anchorIdx === null
                  ? {}
                  : buildRowByHeader(table.headers, table.rows[anchorIdx], {});

              const row = buildSheetRow({
                headers: table.headers,
                mappings: columnMappings,
                // The anchor is in scope for THIS row only, so a column can be
                // filled from the row it sits under (`@<anchorRow.Job No>@`).
                // It is never merged into the workflow context, so it cannot
                // leak downstream.
                context: { ...context, [ANCHOR_ROW_KEY]: anchorRow },
                rows: seenRows,
                serialAsText: true,
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

              seenRows.push(
                row.map((cell) =>
                  cell.startsWith("'") ? cell.slice(1) : cell,
                ),
              );
              return {
                anchorIdx,
                row,
                anchorRow,
                rowByHeader: buildRowByHeader(
                  table.headers,
                  row,
                  columnMappings,
                ),
              };
            });

            const base = {
              matchCount: matches.length,
              insertedUnderGroup: matches.length > 0,
            };

            // Bottom of the data — nothing matched (a NEW group starts here), or
            // the single anchor already IS the last row, in which case appending
            // is inserting under it. One request, and no blank row ever exists on
            // its own, so a dead run leaves nothing to clean up.
            const only = built[0];
            if (
              built.length === 1 &&
              (only.anchorIdx === null ||
                only.anchorIdx === table.rows.length - 1)
            ) {
              const separator =
                only.anchorIdx === null &&
                config.blankSeparators === true &&
                table.rows.length > 0;
              await sheetsWrite(
                `${sheetsValuesUrl(spreadsheetId, sheetRange(sheetName, "A:ZZ"))}:append`,
                {
                  headers: sheetsAuthHeaders(accessToken),
                  searchParams: { valueInputOption: "USER_ENTERED" },
                  json: { values: separator ? [[""], only.row] : [only.row] },
                },
              );
              return {
                ...base,
                written: true,
                blankSeparatorAdded: separator,
                rows: [
                  {
                    ...only,
                    // Sheet row = header + data rows + 1, past the separator if
                    // one was written.
                    rowIndex: table.rows.length + 2 + (separator ? 1 : 0),
                  },
                ],
              };
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
              written: false,
              blankSeparatorAdded: false,
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

      // STEP 2 — fill the rows the insert opened up, all in ONE request. The
      // append path already wrote its row (values.append carries the data), so it
      // skips this. USER_ENTERED (not a batchUpdate `updateCells`) so numbers and
      // dates are parsed exactly as on every other Sheets write in the app.
      if (!placed.written) {
        await step.run("google-sheets-insert-adjacent-write", async () => {
          try {
            await sheetsWrite(
              sheetsValuesBatchUpdateUrl(spreadsheetId),
              {
                headers: sheetsAuthHeaders(accessToken),
                json: {
                  valueInputOption: "USER_ENTERED",
                  data: placed.rows.map((r) => ({
                    range: sheetRange(
                      sheetName,
                      `A${r.rowIndex}:ZZ${r.rowIndex}`,
                    ),
                    values: [r.row],
                  })),
                },
              },
              // Absolute-range fill: the structural insert ran in an EARLIER,
              // memoized step, so a retry of this step rewrites the same cells.
              { idempotent: true },
            );
            return null;
          } catch (error) {
            throw await toSheetsError(error);
          }
        });
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
      }));
      const output: Record<string, unknown> = {
        action,
        spreadsheetId,
        sheetName,
        matchCount: placed.matchCount,
        insertedUnderGroup: placed.insertedUnderGroup,
        blankSeparatorAdded: placed.blankSeparatorAdded,
        rowIndex: first.rowIndex,
        rowByHeader: first.rowByHeader,
        anchorRow: first.anchorRow,
      };
      // Only "each_row" writes more than one row, and only then is the list
      // worth recording (in "group" mode `rowByHeader` already IS the one row).
      // Capped like find_rows' `rows`, so a large fan-out can't bloat the run
      // record — children still get the full list via `items`.
      // The row numbers ride alongside so the run view can say WHERE each added
      // row landed, which is the whole question this action answers.
      if (insertUnder === "each_row") {
        output.insertedRows = items.slice(0, 100).map((i) => i.row);
        output.insertedRowIndexes = items.slice(0, 100).map((i) => i.rowIndex);
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
      // split insert_row_adjacent makes, for the same retry-safety reason.
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

          // Same row-matching as find_rows: one editor, one matcher.
          const matchedIndexes = matchRows(
            table.rowsByHeader,
            config.conditions ?? [],
            context,
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
          // Condition node can branch on `matched`). Otherwise "first" writes one
          // row, "each" writes them all.
          const targets =
            matchedIndexes.length === 0
              ? []
              : mode === "each"
                ? matchedIndexes
                : [matchedIndexes[0]];

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
              return coerceCellValue(renderTemplate(mapping, context));
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
              previousRow: buildRowByHeader(
                table.headers,
                existing,
                columnMappings,
              ),
              rowByHeader: buildRowByHeader(
                table.headers,
                mergedRow,
                columnMappings,
              ),
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
      // survive a step's JSON checkpoint. "first" keeps a single row.
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
        // Preferred path: map upstream data onto the sheet's live columns. All
        // Sheets REST plumbing routes through src/lib/google-sheets.ts.
        if (hasMappings) {
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
            const newRow = buildSheetRow({
              headers: table.headers,
              mappings: columnMappings,
              context,
              // Data rows (header-aligned) so a Serial Number custom-feature
              // column autofills to max(existing)+1.
              rows: table.rows,
              // Keep padded serials (0006) as text — USER_ENTERED would
              // otherwise drop the leading zeros.
              serialAsText: true,
            });

            // Enforce required columns after the row is built (a serial cell is
            // always populated, so it never trips this).
            const blankRequired = findBlankRequired(
              table.headers,
              newRow,
              config.requiredColumns,
            );
            if (blankRequired.length > 0) {
              throw new NonRetriableError(
                `${ERROR_PREFIX}: required column(s) may not be blank: ${blankRequired.join(", ")}`,
              );
            }

            await sheetsWrite(
              `${sheetsValuesUrl(spreadsheetId, sheetRange(sheetName, "A:ZZ"))}:append`,
              {
                headers: sheetsAuthHeaders(accessToken),
                searchParams: { valueInputOption: "USER_ENTERED" },
                json: { values: [newRow] },
              },
            );

            return {
              ...context,
              [outputKey]: {
                action,
                spreadsheetId,
                sheetName,
                appendedRows: 1,
                row: newRow,
                // Header-keyed view of the appended row so downstream nodes
                // pick columns (serial apostrophe + header dots stripped).
                rowByHeader: buildRowByHeader(
                  table.headers,
                  newRow,
                  columnMappings,
                ),
              },
            };
          } catch (error) {
            // Map HTTP failures onto Inngest retry semantics; self-thrown
            // NonRetriableErrors (no header / blank required) pass through.
            throw await toSheetsError(error);
          }
        }

        // Legacy path: raw JSON values + explicit range.
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

          const matches = matchRows(
            table.rowsByHeader,
            config.conditions ?? [],
            context,
          );

          // Multi-match policy ("first"/"each"/"error") is applied OUTSIDE
          // this step (see below) — but "each" needs every matched row as a
          // fan-out item, so its cap is enforced HERE on the true match count
          // (silently truncating children would be worse than failing) before
          // hauling the rows across the step checkpoint.
          const mode = config.onMultipleMatches ?? "first";
          if (mode === "each") {
            assertFanOutCap(matches.length, config.maxFanOutItems, "row");
          }

          // Stored rows are capped ("each" keeps them all — the cap above
          // already bounds the count); the per-column value lists below are
          // computed over ALL matches so a downstream `in_list` is complete.
          // Cells are trimmed so `firstRow`/`rows` agree with `columnValues`.
          const rowLimit = mode === "each" ? matches.length : 100;
          const rows = matches.slice(0, rowLimit).map((m) => {
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
              // The first matched row (sanitized keys), or {} when nothing
              // matched. Lets a downstream node reference a SINGLE value
              // (e.g. `firstRow.Job No`) instead of the columnValues list.
              firstRow: rows[0] ?? {},
            },
          };
        } catch (error) {
          throw await toSheetsError(error);
        }
      }

      // Exhaustiveness: the schema only admits append_row / find_rows /
      // update_row (the legacy read_rows action was removed — find_rows with
      // no conditions reads every row).
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
