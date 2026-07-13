import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import {
  applyMultiMatchPolicy,
  assertFanOutCap,
  assertNoForeignFanOut,
} from "@/features/executions/lib/multi-match-policy";
import type {
  FanOutOutcome,
  NodeExecutor,
  WorkflowContext,
} from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { FAN_OUT_MARKER } from "@/inngest/fan-out";
import { parseCustomFeatureToken } from "@/lib/custom-feature-token";
import {
  readSheetTable,
  sheetRange,
  sheetsAuthHeaders,
  sheetsValuesBatchUpdateUrl,
  sheetsValuesUrl,
  toSheetsError,
} from "@/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { type MultiMatchMode, readFanOutSeed } from "@/lib/multi-match";
import { getRowCell, matchRows, type RowMatchCondition } from "@/lib/row-match";
import { hasActiveRowCondition } from "@/lib/row-match-operators";
import { coerceCellValue } from "@/lib/sheet-cells";
import { sanitizeHeaderKey } from "@/lib/sheet-headers";
import {
  buildRowByHeader,
  buildSheetRow,
  findBlankRequired,
} from "@/lib/sheet-row";
import { renderTemplate } from "@/lib/templating";

type SheetsAction = "append_row" | "find_rows" | "update_row";

type GoogleSheetsActionData = {
  action?: SheetsAction;
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
  // "match the columns" mapping: column header -> template string.
  columnMappings?: Record<string, string>;
  // Headers that may not be blank on append (accessory "may be blank" off).
  requiredColumns?: string[];
  // AND-ed row filter, shared by find_rows (which returns the matches) and
  // update_row (which writes them). update_row requires at least one.
  conditions?: RowMatchCondition[];
  // Multi-match policy for find_rows / update_row (see src/lib/multi-match.ts).
  onMultipleMatches?: MultiMatchMode;
  maxFanOutItems?: number;
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
      return {
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
      };
    }

    const columnValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(item)) {
      columnValues[key] = JSON.stringify([value]);
    }
    return {
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
    };
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

            await ky.post(
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

        await ky.post(
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

      if (action === "update_row") {
        try {
          // An empty filter makes matchRows vacuously true — it would select
          // EVERY row and overwrite the whole sheet. The config schema rejects
          // this too; re-checked here because the executor is what writes.
          if (!hasActiveRowCondition(config.conditions)) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: updating rows needs at least one filter condition — ` +
                `an empty filter would overwrite every row in "${sheetName}"`,
            );
          }

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

          // This action ONLY updates rows that already exist. Nothing matched ⇒
          // nothing to write: a clean no-op that succeeds, so a Condition node
          // can branch on `matched` and hand the "row isn't there yet" case to
          // a row-adding action instead.
          if (matchedIndexes.length === 0) {
            return {
              ...context,
              [outputKey]: {
                action,
                spreadsheetId,
                sheetName,
                matched: false,
                matchCount: 0,
              },
            };
          }

          // Matched. The policy decides WHICH rows the write lands on, and it
          // must be settled BEFORE writing — unlike find_rows (a pure read),
          // an update cannot be un-written once the request goes out, so the
          // "error" check, the nested-fan-out guard and the cap all run here
          // rather than in applyMultiMatchPolicy after the step.
          const mode = config.onMultipleMatches ?? "first";
          if (mode === "error" && matchedIndexes.length > 1) {
            throw new NonRetriableError(
              `${ERROR_PREFIX}: ${matchedIndexes.length} rows match the filter, but ` +
                `this step is set to fail when more than one does. Switch it to ` +
                `update every matching row, or narrow the filter.`,
            );
          }
          if (mode === "each") {
            assertNoForeignFanOut(context, outputKey);
            assertFanOutCap(
              matchedIndexes.length,
              config.maxFanOutItems,
              "row",
            );
          }

          const targets =
            mode === "each" ? matchedIndexes : [matchedIndexes[0]];

          // The final value of every cell in each target row. Mapped columns are
          // overwritten with the rendered value; everything else is `null`, which
          // Sheets leaves untouched. Writing the full, final value (rather than a
          // relative change) is what makes a retried write safe: it rewrites
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
            // existing cell where we passed null — so `rowByHeader` reflects
            // the whole row (W1's SWITCH reads unmapped columns off it too).
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

          // ONE request for every target row ("first" writes a single-element
          // batch — one write path, no branching).
          await ky.post(sheetsValuesBatchUpdateUrl(spreadsheetId), {
            headers: sheetsAuthHeaders(accessToken),
            json: {
              valueInputOption: "USER_ENTERED",
              data: writes.map((w) => w.valueRange),
            },
          });

          return {
            ...context,
            [outputKey]: {
              action,
              spreadsheetId,
              sheetName,
              matched: true,
              matchCount: matchedIndexes.length,
              rowIndex: writes[0].rowIndex,
              previousRow: writes[0].previousRow,
              rowByHeader: writes[0].rowByHeader,
              // "each" fans out on these below; harmless in the other modes.
              updatedRows: writes.map((w) => w.rowByHeader),
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
    let outcome: WorkflowContext | FanOutOutcome = result;

    if (action === "find_rows") {
      // `output.rows` already respects the policy ("each" kept every matched
      // row as a fan-out item, cap enforced in-step; other modes store ≤ 100).
      // The SUMMARY recorded for the parent is capped back to 100 rows so a
      // large fan-out can't bloat the run record — the full list still reaches
      // the children via `items`.
      const output = result[outputKey] as Record<string, unknown>;
      const rows = Array.isArray(output.rows) ? output.rows : [];
      outcome = applyMultiMatchPolicy({
        mode: config.onMultipleMatches,
        maxItems: config.maxFanOutItems,
        items: rows,
        totalCount:
          typeof output.matchCount === "number" ? output.matchCount : undefined,
        context: result,
        outputKey,
        output:
          rows.length > 100 ? { ...output, rows: rows.slice(0, 100) } : output,
        itemNoun: "row",
      });
    } else if (action === "update_row") {
      // The write already happened (and already obeyed the policy — the mode
      // chose which rows it landed on). All that is left is the fan-out: in
      // "each" mode, start one child run per row we updated. `updatedRows` is
      // the internal carrier for those items; it is stripped from the recorded
      // output, where `rowByHeader` + `matchCount` already tell the story.
      const { updatedRows, ...output } = result[outputKey] as Record<
        string,
        unknown
      >;
      const items = Array.isArray(updatedRows) ? updatedRows : [];
      // A no-match run wrote nothing, so it has nothing to fan out over — and
      // fanning out ZERO children would make the engine skip the entire
      // downstream sub-graph, which is exactly the branch that needs to run
      // (it's what handles the missing row). So it threads through normally.
      outcome =
        items.length > 0
          ? applyMultiMatchPolicy({
              mode: config.onMultipleMatches,
              maxItems: config.maxFanOutItems,
              items,
              context: result,
              outputKey,
              output,
              itemNoun: "row",
            })
          : { ...result, [outputKey]: output };
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
