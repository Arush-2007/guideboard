import Handlebars from "handlebars";
import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { googleSheetsActionChannel } from "@/inngest/channels/google-sheets-action";

type GoogleSheetsActionData = {
  action?: "append_row" | "read_rows";
  spreadsheetId?: string;
  sheetName?: string;
  range?: string;
  values?: string;
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
    throw new NonRetriableError("Google Sheets Action: values must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new NonRetriableError("Google Sheets Action: values must be an array");
  }

  if (parsed.length === 0) return [];
  if (Array.isArray(parsed[0])) {
    return (parsed as unknown[][]).map((row) =>
      row.map((cell) => String(cell ?? "")),
    );
  }

  return [(parsed as unknown[]).map((cell) => String(cell ?? ""))];
}

export const googleSheetsActionExecutor: NodeExecutor<GoogleSheetsActionData> =
  async ({ data, nodeId, userId, context, step, publish }) => {
    await publish(
      googleSheetsActionChannel().status({
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
        googleSheetsActionChannel().status({
          nodeId,
          status: "error",
        }),
      );
      throw new NonRetriableError(
        error instanceof Error ? error.message : "Invalid node config",
      );
    }

    const outputKey = `${NodeType.GOOGLE_SHEETS_ACTION.toLowerCase()}_${nodeId}`;
    const action = config.action ?? "append_row";
    const spreadsheetId = decode(
      Handlebars.compile(config.spreadsheetId ?? "")(context),
    ).trim();
    const sheetName = decode(Handlebars.compile(config.sheetName ?? "")(context)).trim();
    const range = decode(Handlebars.compile(config.range ?? "")(context)).trim();

    if (!spreadsheetId || !sheetName || !range) {
      await publish(
        googleSheetsActionChannel().status({
          nodeId,
          status: "error",
        }),
      );
      throw new NonRetriableError(
        "Google Sheets Action: spreadsheetId, sheetName, and range are required",
      );
    }

    const accessToken = await refreshGoogleTokenIfNeeded(userId);
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
    const a1Range = `${sheetName}!${range}`;

    try {
      const result = await step.run("google-sheets-action", async () => {
        if (action === "append_row") {
          const renderedValues = decode(
            Handlebars.compile(config.values ?? "")(context),
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
        googleSheetsActionChannel().status({
          nodeId,
          status: "success",
        }),
      );
      return result;
    } catch (error) {
      await publish(
        googleSheetsActionChannel().status({
          nodeId,
          status: "error",
        }),
      );
      throw error;
    }
  };
