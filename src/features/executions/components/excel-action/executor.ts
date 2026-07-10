import { decode } from "html-entities";
import { NonRetriableError, RetryAfterError } from "inngest";
import ky, { HTTPError } from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { refreshMicrosoftTokenIfNeeded } from "@/lib/microsoft-token";
import {
  getFirstTableOnWorksheet,
  getTableColumnNames,
  graphHeaders,
  odataQuote,
  workbookUrl,
} from "@/lib/ms-graph";
import { coerceCellValue, toCellNumber } from "@/lib/sheet-cells";
import { buildSheetRow, isSerialHeader } from "@/lib/sheet-row";
import { renderTemplate } from "@/lib/templating";

type ExcelActionData = {
  operation?: "append_row" | "upsert_by_key";
  workbookId?: string;
  worksheetName?: string;
  // "match the columns" mapping: column header -> template string.
  columnMappings?: Record<string, string>;
  keyColumn?: string;
  keyValue?: string;
  // header -> how upsert writes a matched row's cell: overwrite ("set") or
  // numeric accumulate ("add", for running totals).
  columnModes?: Record<string, "set" | "add">;
};

type GraphErrorBody = { error?: { code?: string; message?: string } };
type RangeValuesResponse = { values?: unknown[][]; rowCount?: number };
type TableRowResponse = { values?: unknown[][] };
type CreateSessionResponse = { id?: string };

/**
 * Maps a Graph HTTP failure onto Inngest retry semantics: 423 (workbook
 * locked) and 429 honor Retry-After; 4xx config/permission problems don't
 * retry; everything else (Excel's calc service throws transient 5xx) does.
 */
async function toGraphError(error: unknown): Promise<Error> {
  if (!(error instanceof HTTPError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const status = error.response.status;
  let code = "";
  let detail = error.message;
  try {
    const body = (await error.response.json()) as GraphErrorBody;
    code = body.error?.code ?? "";
    detail = body.error?.message ?? detail;
  } catch {
    // non-JSON error body — keep the HTTP message
  }
  const message = `Excel Action: Microsoft Graph ${status}${code ? ` (${code})` : ""}: ${detail}`;

  if (status === 423) return new RetryAfterError(message, "30s");
  if (status === 429) {
    const retryAfter = error.response.headers.get("retry-after");
    return new RetryAfterError(message, retryAfter ? `${retryAfter}s` : "30s");
  }
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return new NonRetriableError(message);
  }
  return new Error(message);
}

export const excelActionExecutor: NodeExecutor<ExcelActionData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    nodeStatusChannel(userId).status({ nodeId, status: "loading" }),
  );

  let config: ExcelActionData;
  try {
    config = parseNodeConfig(NodeType.EXCEL_ACTION, data) as ExcelActionData;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const operation = config.operation ?? "append_row";
  const workbookId = (config.workbookId ?? "").trim();
  const worksheetName = decode(
    renderTemplate(config.worksheetName ?? "", context),
  ).trim();
  const columnMappings = config.columnMappings ?? {};
  const columnModes = config.columnModes ?? {};
  const keyColumn = (config.keyColumn ?? "").trim();
  const keyValue = decode(
    renderTemplate(config.keyValue ?? "", context),
  ).trim();

  const hasMappings = Object.values(columnMappings).some(
    (v) => typeof v === "string" && v.trim(),
  );

  const fail = async (message: string): Promise<never> => {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(message);
  };

  if (!workbookId || !worksheetName) {
    await fail("Excel Action: workbook and worksheet are required");
  }
  if (!hasMappings) {
    await fail("Excel Action: map at least one column");
  }
  if (operation === "upsert_by_key" && (!keyColumn || !keyValue)) {
    await fail(
      "Excel Action: upsert needs a key column and a non-empty key value",
    );
  }

  try {
    const result = await step.run("excel-action", async () => {
      try {
        let accessToken: string;
        try {
          accessToken = await refreshMicrosoftTokenIfNeeded(userId);
        } catch (error) {
          throw new NonRetriableError(
            error instanceof Error
              ? error.message
              : "Microsoft token refresh failed",
          );
        }

        const table = await getFirstTableOnWorksheet({
          accessToken,
          workbookId,
          worksheetName,
        });
        if (!table) {
          throw new NonRetriableError(
            `Excel Action: worksheet "${worksheetName}" has no Excel Table. Select the data (including headers) and press Ctrl+T to format it as a Table, then run again.`,
          );
        }

        const headers = await getTableColumnNames({
          accessToken,
          workbookId,
          tableName: table.name,
        });
        if (headers.length === 0) {
          throw new NonRetriableError(
            `Excel Action: the Table on "${worksheetName}" has no column headers`,
          );
        }

        const tableUrl = `${workbookUrl(workbookId)}/tables('${odataQuote(table.name)}')`;

        const appendRow = async ({
          currentDataRowCount,
          sessionId,
        }: {
          currentDataRowCount: number;
          sessionId?: string;
        }) => {
          const newRow = buildSheetRow({
            headers,
            mappings: columnMappings,
            context,
            // Excel is on halt and keeps the header-name serial autofill; Sheets
            // uses the Serial Number custom feature instead.
            legacyHeaderSerial: true,
            legacyRowCount: currentDataRowCount,
          }).map(coerceCellValue);

          // On upsert-insert, an unmapped key column still must carry the key
          // so the row is findable next run.
          if (operation === "upsert_by_key") {
            const keyIndex = headers.findIndex(
              (h) => h.trim().toLowerCase() === keyColumn.toLowerCase(),
            );
            if (keyIndex === -1) {
              throw new NonRetriableError(
                `Excel Action: key column "${keyColumn}" is not a column of the Table on "${worksheetName}"`,
              );
            }
            if (String(newRow[keyIndex] ?? "").trim() === "") {
              newRow[keyIndex] = keyValue;
            }
          }

          await ky.post(`${tableUrl}/rows/add`, {
            headers: graphHeaders(accessToken, sessionId),
            json: { values: [newRow] },
          });
          return newRow;
        };

        if (operation === "append_row") {
          // The data row count is only needed to autofill an unmapped
          // serial-number column ("S.No" etc.).
          const needsRowCount = headers.some(
            (h) => !columnMappings[h.trim()]?.trim() && isSerialHeader(h),
          );
          let currentDataRowCount = 0;
          if (needsRowCount) {
            const body = await ky
              .get(`${tableUrl}/dataBodyRange`, {
                searchParams: { $select: "rowCount" },
                headers: graphHeaders(accessToken),
              })
              .json<RangeValuesResponse>();
            currentDataRowCount = body.rowCount ?? 0;
            // A table with no data yet still reports one blank placeholder row.
            if (currentDataRowCount === 1) {
              const check = await ky
                .get(`${tableUrl}/dataBodyRange`, {
                  searchParams: { $select: "values" },
                  headers: graphHeaders(accessToken),
                })
                .json<RangeValuesResponse>();
              const onlyRow = check.values?.[0] ?? [];
              if (onlyRow.every((cell) => String(cell ?? "").trim() === "")) {
                currentDataRowCount = 0;
              }
            }
          }

          const newRow = await appendRow({ currentDataRowCount });
          return {
            ...context,
            [outputKey]: {
              operation,
              workbookId,
              worksheetName,
              tableName: table.name,
              matched: false,
              row: newRow,
            },
          };
        }

        // upsert_by_key: a workbook session pins the scan and the patch to the
        // same snapshot, so the row index found is the row index written even
        // while the file is open in desktop Excel.
        const session = await ky
          .post(`${workbookUrl(workbookId)}/createSession`, {
            headers: graphHeaders(accessToken),
            json: { persistChanges: true },
          })
          .json<CreateSessionResponse>();
        const sessionId = session.id;

        try {
          const keyColumnData = await ky
            .get(
              `${tableUrl}/columns('${odataQuote(keyColumn)}')/dataBodyRange`,
              {
                searchParams: { $select: "values" },
                headers: graphHeaders(accessToken, sessionId),
              },
            )
            .json<RangeValuesResponse>();

          const keyRows = (keyColumnData.values ?? []).map((row) =>
            String(row?.[0] ?? "").trim(),
          );
          // Same empty-table placeholder as above: one all-blank row = no data.
          const isEmptyTable = keyRows.length === 1 && keyRows[0] === "";
          const dataRows = isEmptyTable ? [] : keyRows;

          const needle = keyValue.toLowerCase();
          const matchedIndexes = dataRows.reduce<number[]>((acc, v, i) => {
            if (v.toLowerCase() === needle) acc.push(i);
            return acc;
          }, []);

          if (matchedIndexes.length === 0) {
            const newRow = await appendRow({
              currentDataRowCount: dataRows.length,
              sessionId,
            });
            return {
              ...context,
              [outputKey]: {
                operation,
                workbookId,
                worksheetName,
                tableName: table.name,
                matched: false,
                matchedRows: 0,
                row: newRow,
              },
            };
          }

          const rowIndex = matchedIndexes[0];
          const needsExisting = headers.some(
            (h) =>
              columnMappings[h.trim()]?.trim() &&
              columnModes[h.trim()] === "add",
          );

          let existingRow: unknown[] = [];
          if (needsExisting) {
            const current = await ky
              .get(`${tableUrl}/rows/itemAt(index=${rowIndex})`, {
                searchParams: { $select: "values" },
                headers: graphHeaders(accessToken, sessionId),
              })
              .json<TableRowResponse>();
            existingRow = current.values?.[0] ?? [];
          }

          // null cells keep their current value — only mapped columns change.
          const patchRow = headers.map((rawHeader, index) => {
            const header = rawHeader.trim();
            const template = columnMappings[header];
            if (!template?.trim()) return null;

            const rendered = renderTemplate(template, context);
            if (columnModes[header] === "add") {
              return (
                toCellNumber(existingRow[index], header, "Excel Action") +
                toCellNumber(rendered, header, "Excel Action")
              );
            }
            return coerceCellValue(rendered);
          });

          await ky.patch(`${tableUrl}/rows/itemAt(index=${rowIndex})`, {
            headers: graphHeaders(accessToken, sessionId),
            json: { values: [patchRow] },
          });

          return {
            ...context,
            [outputKey]: {
              operation,
              workbookId,
              worksheetName,
              tableName: table.name,
              matched: true,
              matchedRows: matchedIndexes.length,
              rowIndex,
              row: patchRow,
            },
          };
        } finally {
          if (sessionId) {
            await ky
              .post(`${workbookUrl(workbookId)}/closeSession`, {
                headers: graphHeaders(accessToken, sessionId),
              })
              .catch(() => {
                // best-effort: an orphaned session times out on its own
              });
          }
        }
      } catch (error) {
        throw await toGraphError(error);
      }
    });

    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
    );
    return result;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw error;
  }
};
