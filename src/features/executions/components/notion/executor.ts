import { decode } from "html-entities";
import { NonRetriableError } from "inngest";
import ky from "ky";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { CredentialType, NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { renderTemplate } from "@/lib/templating";

const NOTION_VERSION = "2022-06-28";
const NOTION_RICH_TEXT_MAX = 2000;
const MAX_CHILD_BLOCKS = 99;

type NotionActionData = {
  credentialId?: string;
  action?: "create_page" | "append_to_database";
  pageTitle?: string;
  content?: string;
  parentPageId?: string;
  databaseId?: string;
};

function normalizeNotionId(raw: string): string {
  return raw.replace(/-/g, "").replace(/\s/g, "");
}

function formatNotionUuid(compact: string): string {
  const h = compact.replace(/[^a-fA-F0-9]/g, "");
  if (h.length !== 32) return compact;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function splitRichTextChunks(s: string): string[] {
  const chunks: string[] = [];
  let rest = s;
  while (rest.length > 0) {
    chunks.push(rest.slice(0, NOTION_RICH_TEXT_MAX));
    rest = rest.slice(NOTION_RICH_TEXT_MAX);
  }
  return chunks.length > 0 ? chunks : [" "];
}

function paragraphBlock(text: string) {
  const chunks = splitRichTextChunks(text);
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: {
      rich_text: chunks.map((content) => ({
        type: "text" as const,
        text: { content },
      })),
    },
  };
}

function contentToParagraphBlocks(body: string) {
  const trimmed = body.trim();
  const lines = trimmed
    .split(/\n+/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const parts = lines.length > 0 ? lines : [trimmed || " "];
  return parts.slice(0, MAX_CHILD_BLOCKS).map(paragraphBlock);
}

export const notionExecutor: NodeExecutor<NotionActionData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: NotionActionData;
  try {
    config = parseNodeConfig(NodeType.NOTION_ACTION, data) as NotionActionData;
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

  const credential = await step.run("get-notion-credential", () => {
    return prisma.credential.findUnique({
      where: { id: config.credentialId, userId },
    });
  });

  if (!credential || credential.type !== CredentialType.NOTION) {
    await publish(nodeStatusChannel(userId).status({ nodeId, status: "error" }));
    throw new NonRetriableError(
      "Notion node: Notion credential not found or wrong type",
    );
  }

  let token: string;
  try {
    if (credential.type !== CredentialType.NOTION) {
      throw new Error("Wrong credential type");
    }
    token = decrypt(credential.value).trim();
  } catch {
    await publish(nodeStatusChannel(userId).status({ nodeId, status: "error" }));
    throw new NonRetriableError(
      "Notion node: Failed to read integration token",
    );
  }

  if (!token) {
    await publish(nodeStatusChannel(userId).status({ nodeId, status: "error" }));
    throw new NonRetriableError("Notion node: Integration token is empty");
  }

  const title = decode(renderTemplate(config.pageTitle ?? "", context)).trim();
  const body = decode(renderTemplate(config.content ?? "", context));
  const children = contentToParagraphBlocks(body);
  const notionHeaders = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  try {
    const result = await step.run("notion-create-page", async () => {
      if (!title) {
        throw new NonRetriableError("Notion node: Page title is required");
      }
      let requestBody: Record<string, unknown>;

      if (config.action === "create_page") {
        const rawParent = decode(
          renderTemplate(config.parentPageId ?? "", context),
        ).trim();
        const pageId = formatNotionUuid(normalizeNotionId(rawParent));
        if (!pageId) {
          throw new NonRetriableError(
            "Notion node: Parent page ID is required",
          );
        }
        requestBody = {
          parent: { page_id: pageId },
          properties: {
            title: {
              title: [
                {
                  type: "text",
                  text: { content: title },
                },
              ],
            },
          },
          children,
        };
      } else {
        const rawDb = decode(
          renderTemplate(config.databaseId ?? "", context),
        ).trim();
        const databaseId = formatNotionUuid(normalizeNotionId(rawDb));
        if (!databaseId) {
          throw new NonRetriableError("Notion node: Database ID is required");
        }
        requestBody = {
          parent: { database_id: databaseId },
          properties: {
            Name: {
              title: [
                {
                  type: "text",
                  text: { content: title },
                },
              ],
            },
          },
          children,
        };
      }

      const res = await ky
        .post("https://api.notion.com/v1/pages", {
          headers: notionHeaders,
          json: requestBody,
        })
        .json<{ id: string; url?: string }>();

      return {
        ...context,
        [outputKey]: {
          pageId: res.id,
          url: res.url ?? null,
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
