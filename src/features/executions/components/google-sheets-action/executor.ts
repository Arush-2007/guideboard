import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { buildSheetRow } from "@/lib/sheet-row";
import { renderTemplate } from "@/lib/templating";

type GoogleSheetsActionData = {
  action?: "append_row" | "read_rows";
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
  // "match the columns" mapping: column header -> template string.
  columnMappings?: Record<string, string>;
};

type GoogleSheetsReadResponse = {
  range?: string;
  majorDimension?: string;
  values?: string[][];
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

  // Range is only needed for read_rows or the legacy values-based append.
  if (!hasMappings && !range) {
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
        // Preferred path: map upstream data onto the sheet's live columns.
        if (hasMappings) {
          const fullRange = `${sheetName}!A:ZZ`;
          const existing = await ky
            .get(
              `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(fullRange)}`,
              { headers: { Authorization: `Bearer ${accessToken}` } },
            )
            .json<GoogleSheetsReadResponse>();

          const rows = existing.values ?? [];
          const headerRow = rows[0] ?? [];
          if (headerRow.length === 0) {
            throw new NonRetriableError(
              "Google Sheets Action: the sheet has no header row (row 1) to map columns to",
            );
          }
          const currentDataRowCount = Math.max(rows.length - 1, 0);

          const newRow = buildSheetRow({
            headers: headerRow,
            mappings: columnMappings,
            context,
            currentDataRowCount,
          });

          await ky.post(
            `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(fullRange)}:append`,
            {
              headers,
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
            },
          };
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

      // read_rows
      const a1Range = `${sheetName}!${range}`;
      const readResult = await ky
        .get(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(a1Range)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        .json<GoogleSheetsReadResponse>();

      return {
        ...context,
        [outputKey]: {
          action,
          spreadsheetId,
          sheetName,
          range,
          rows: readResult.values ?? [],
        },
      };
    });

    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );
    return result;
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
