import ky from "ky";

/**
 * Minimal Microsoft Graph plumbing shared by the credentials tRPC procedures
 * (workbook/worksheet/column dropdowns) and the Excel action executor. All
 * Excel access goes through the workbook API, which only works on OneDrive
 * for Business (work/school accounts) — see the Microsoft connect flow.
 */

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function workbookUrl(itemId: string): string {
  return `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}/workbook`;
}

// OData string literal inside a ('...') path segment: single quotes are
// escaped by doubling, then the whole literal is percent-encoded.
export function odataQuote(name: string): string {
  return encodeURIComponent(name.replace(/'/g, "''"));
}

export function graphHeaders(
  accessToken: string,
  sessionId?: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(sessionId ? { "workbook-session-id": sessionId } : {}),
  };
}

export type GraphTable = { id: string; name: string };

/**
 * The first Excel Table on a worksheet, or null when the sheet has none (the
 * Excel node requires the target data to be formatted as a Table).
 */
export async function getFirstTableOnWorksheet({
  accessToken,
  workbookId,
  worksheetName,
  sessionId,
}: {
  accessToken: string;
  workbookId: string;
  worksheetName: string;
  sessionId?: string;
}): Promise<GraphTable | null> {
  type TablesResponse = { value?: Array<{ id?: string; name?: string }> };

  const data = await ky
    .get(
      `${workbookUrl(workbookId)}/worksheets('${odataQuote(worksheetName)}')/tables`,
      {
        searchParams: { $select: "id,name" },
        headers: graphHeaders(accessToken, sessionId),
      },
    )
    .json<TablesResponse>();

  const table = (data.value ?? []).find((t) => t.id && t.name);
  return table ? { id: table.id ?? "", name: table.name ?? "" } : null;
}

/** Column header names of a table, in sheet order. */
export async function getTableColumnNames({
  accessToken,
  workbookId,
  tableName,
  sessionId,
}: {
  accessToken: string;
  workbookId: string;
  tableName: string;
  sessionId?: string;
}): Promise<string[]> {
  type ColumnsResponse = { value?: Array<{ name?: string }> };

  const data = await ky
    .get(
      `${workbookUrl(workbookId)}/tables('${odataQuote(tableName)}')/columns`,
      {
        searchParams: { $select: "name" },
        headers: graphHeaders(accessToken, sessionId),
      },
    )
    .json<ColumnsResponse>();

  return (data.value ?? [])
    .map((c) => String(c.name ?? "").trim())
    .filter((name) => name.length > 0);
}
