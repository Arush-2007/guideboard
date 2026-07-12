import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { CredentialType, NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { readSheetTable } from "@/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { getRowCell } from "@/lib/row-match";
import { renderTemplate } from "@/lib/templating";

/**
 * Generic "does this value exist in a store?" lookup. It searches a Google Sheet
 * column or a Notion database property for a value and returns
 * `{ exists, matchCount, matched }` — WITHOUT branching. Pair it with a Condition
 * node (`@<RECORD_LOOKUP_1.exists>@` equals `true`) to route. Kept a plain,
 * composable primitive so any workflow can use it (dedupe, "seen this customer",
 * inventory checks, gating), not just HR.
 */
type RecordLookupSource = "google_sheets" | "notion";

type RecordLookupData = {
  source?: RecordLookupSource;
  value?: string;
  // google_sheets
  spreadsheetId?: string;
  sheetName?: string;
  column?: string;
  // notion
  credentialId?: string;
  databaseId?: string;
  property?: string;
};

type LookupResult = {
  exists: boolean;
  matchCount: number;
  /** The first matching record (row object / Notion page ref), or null. */
  matched: unknown;
};

const NOTION_VERSION = "2022-06-28";

function normalizeNotionId(raw: string): string {
  const h = raw.replace(/[^a-fA-F0-9]/g, "");
  if (h.length !== 32) return raw.trim();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Notion property types we can build an `equals` filter for. */
const NOTION_TEXT_TYPES = new Set([
  "title",
  "rich_text",
  "email",
  "phone_number",
  "url",
  "select",
]);

async function lookupGoogleSheets(
  userId: string,
  config: RecordLookupData,
  value: string,
): Promise<LookupResult> {
  const spreadsheetId = config.spreadsheetId?.trim();
  const sheetName = config.sheetName?.trim();
  const column = (config.column ?? "").trim();
  if (!spreadsheetId || !sheetName) {
    throw new NonRetriableError(
      "Record Lookup: a spreadsheet and tab name are required",
    );
  }
  if (!column) {
    throw new NonRetriableError(
      "Record Lookup: the column to search is required",
    );
  }

  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const table = await readSheetTable({ accessToken, spreadsheetId, sheetName });

  // No such column yet (e.g. a brand-new, header-only sheet) -> nothing matches.
  const target = column.toLowerCase();
  if (!table.headers.some((h) => h.toLowerCase() === target)) {
    return { exists: false, matchCount: 0, matched: null };
  }

  // Case-insensitive, trimmed value match (record-lookup's own semantics — NOT
  // the case-sensitive branching comparator, so it stays byte-compatible).
  const needle = value.toLowerCase();
  let matchCount = 0;
  let matched: unknown = null;
  for (const row of table.rowsByHeader) {
    if (getRowCell(row, column).trim().toLowerCase() === needle) {
      matchCount++;
      // First match: the whole header-keyed row (same shape as before).
      if (matched === null) matched = row;
    }
  }
  return { exists: matchCount > 0, matchCount, matched };
}

async function lookupNotion(
  userId: string,
  config: RecordLookupData,
  value: string,
): Promise<LookupResult> {
  const databaseId = config.databaseId?.trim();
  const property = (config.property ?? "").trim();
  if (!databaseId) {
    throw new NonRetriableError("Record Lookup: a Notion database is required");
  }
  if (!property) {
    throw new NonRetriableError(
      "Record Lookup: the Notion property to search is required",
    );
  }

  const credential = await prisma.credential.findUnique({
    where: { id: config.credentialId, userId },
  });
  if (!credential || credential.type !== CredentialType.NOTION) {
    throw new NonRetriableError(
      "Record Lookup: Notion credential not found or wrong type",
    );
  }
  const token = decrypt(credential.value).trim();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
  const dbId = normalizeNotionId(databaseId);

  // Resolve the property's type so we build a filter Notion accepts.
  const db = await ky
    .get(`https://api.notion.com/v1/databases/${dbId}`, { headers })
    .json<{
      properties?: Record<string, { type?: string }>;
    }>();
  const propType = db.properties?.[property]?.type;
  if (!propType) {
    throw new NonRetriableError(
      `Record Lookup: property "${property}" not found on the Notion database`,
    );
  }

  let filter: Record<string, unknown>;
  if (NOTION_TEXT_TYPES.has(propType)) {
    filter = { property, [propType]: { equals: value } };
  } else if (propType === "number") {
    const num = Number(value);
    if (Number.isNaN(num)) {
      throw new NonRetriableError(
        `Record Lookup: "${value}" is not a number for property "${property}"`,
      );
    }
    filter = { property, number: { equals: num } };
  } else {
    throw new NonRetriableError(
      `Record Lookup: Notion property type "${propType}" is not supported`,
    );
  }

  const res = await ky
    .post(`https://api.notion.com/v1/databases/${dbId}/query`, {
      headers,
      json: { filter, page_size: 5 },
    })
    .json<{ results?: Array<{ id: string; url?: string }> }>();

  const results = res.results ?? [];
  const first = results[0];
  return {
    exists: results.length > 0,
    matchCount: results.length,
    matched: first ? { id: first.id, url: first.url ?? null } : null,
  };
}

export const recordLookupExecutor: NodeExecutor<RecordLookupData> = async ({
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

  let config: RecordLookupData;
  try {
    config = parseNodeConfig(NodeType.RECORD_LOOKUP, data) as RecordLookupData;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const source: RecordLookupSource = config.source ?? "google_sheets";
  const value = decode(renderTemplate(config.value ?? "", context)).trim();
  if (!value) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      "Record Lookup: a value to search for is required",
    );
  }

  try {
    const result = await step.run("record-lookup", () =>
      source === "notion"
        ? lookupNotion(userId, config, value)
        : lookupGoogleSheets(userId, config, value),
    );

    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "success" }),
    );

    return { ...context, [outputKey]: result };
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    if (error instanceof NonRetriableError) throw error;
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Record lookup failed",
    );
  }
};
