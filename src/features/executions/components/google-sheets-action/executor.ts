import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import {
  applyMultiMatchPolicy,
  assertFanOutCap,
} from "@/features/executions/lib/multi-match-policy";
import type {
  FanOutOutcome,
  NodeExecutor,
  WorkflowContext,
} from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { FAN_OUT_MARKER } from "@/inngest/fan-out";
import {
  readSheetTable,
  sheetsAuthHeaders,
  sheetsValuesUrl,
  toSheetsError,
} from "@/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { type MultiMatchMode, readFanOutSeed } from "@/lib/multi-match";
import { getRowCell, matchRows, type RowMatchCondition } from "@/lib/row-match";
import { sanitizeHeaderKey } from "@/lib/sheet-headers";
import {
  buildRowByHeader,
  buildSheetRow,
  findBlankRequired,
} from "@/lib/sheet-row";
import { renderTemplate } from "@/lib/templating";

type GoogleSheetsActionData = {
  action?: "append_row" | "find_rows";
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
  // "match the columns" mapping: column header -> template string.
  columnMappings?: Record<string, string>;
  // Headers that may not be blank on append (accessory "may be blank" off).
  requiredColumns?: string[];
  // find_rows: AND-ed filter conditions (every column is returned).
  conditions?: RowMatchCondition[];
  // find_rows multi-match policy (see src/lib/multi-match.ts).
  onMultipleMatches?: MultiMatchMode;
  maxFanOutItems?: number;
};

function parseValuesJson(raw: string): string[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NonRetriableError(
      "Google Sheets Action: values must be valid JSON",
    );
  }

  if (!Array.isArray(parsed)) {
    throw new NonRetriableError(
      "Google Sheets Action: values must be an array",
    );
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
      "Google Sheets Action: spreadsheetId and sheetName are required",
    );
  }

  // Fan-out child run: the engine re-ran this node with a per-item seed under
  // its own output key (this node fanned out in the parent run — find_rows,
  // "each" mode). Reshape the seed into a normal single-match find_rows output
  // instead of re-querying Sheets, so downstream references (`firstRow.<col>`,
  // `rows`, `matchCount`) resolve identically in every mode.
  const seed = readFanOutSeed(context, outputKey);
  if (seed) {
    const item = (seed.item ?? {}) as Record<string, unknown>;
    const columnValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(item)) {
      columnValues[key] = JSON.stringify([value]);
    }
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
    );
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
        index: seed.index,
        total: seed.total,
        // Keep the marker: a retry of this child run must still short-circuit,
        // and a later "each"-mode node in this run must see it (nested guard).
        [FAN_OUT_MARKER]: true,
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
      "Google Sheets Action: a column mapping or a range is required",
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
                "Google Sheets Action: the sheet has no header row (row 1) to map columns to",
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
                `Google Sheets Action: required column(s) may not be blank: ${blankRequired.join(", ")}`,
              );
            }

            await ky.post(
              `${sheetsValuesUrl(spreadsheetId, `${sheetName}!A:ZZ`)}:append`,
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
        const a1Range = `${sheetName}!${range}`;
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

      // Exhaustiveness: the schema only admits append_row / find_rows (the
      // legacy read_rows action was removed — find_rows with no conditions
      // reads every row).
      throw new NonRetriableError(
        `Google Sheets Action: unsupported action "${action}"`,
      );
    });

    // find_rows: apply the multi-match policy OUTSIDE the step — the branded
    // fan-out outcome carries a symbol that would not survive the step's JSON
    // checkpoint round-trip. `output.rows` respects the policy ("each" kept
    // every matched row as fan-out items, cap enforced in-step; other modes
    // store ≤ 100) — but the SUMMARY output recorded for the parent is capped
    // back to 100 rows so a large fan-out can't bloat the run record; the full
    // list still reaches the children via `items`.
    let outcome: WorkflowContext | FanOutOutcome = result;
    if (action === "find_rows") {
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
