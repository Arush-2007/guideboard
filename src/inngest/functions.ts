import { NonRetriableError } from "inngest";
import { inngest } from "./client";
import prisma from "@/lib/db";
import { topologicalSort, sendWorkflowExecution } from "./utils";
import { ExecutionStatus, NodeType } from "@/generated/prisma";
import { getExecutor } from "@/features/executions/lib/executor-registry";
import { fetchNewYoutubeComments } from "@/lib/youtube-comments";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import ky from "ky";
import { httpRequestChannel } from "./channels/http-request";
import { conditionChannel } from "./channels/condition";
import { manualTriggerChannel } from "./channels/manual-trigger";
import { googleFormTriggerChannel } from "./channels/google-form-trigger";
import { typeformTriggerChannel } from "./channels/typeform-trigger";
import { geminiChannel } from "./channels/gemini";
import { openAiChannel } from "./channels/openai";
import { anthropicChannel } from "./channels/anthropic";
import { discordChannel } from "./channels/discord";
import { slackChannel } from "./channels/slack";
import { notionChannel } from "./channels/notion";
import { telegramActionChannel } from "./channels/telegram-action";
import { telegramTriggerChannel } from "./channels/telegram-trigger";
import { whatsappActionChannel } from "./channels/whatsapp-action";
import { gmailActionChannel } from "./channels/gmail-action";
import { gmailTriggerChannel } from "./channels/gmail-trigger";
import { googleSheetsActionChannel } from "./channels/google-sheets-action";
import { googleSheetsTriggerChannel } from "./channels/google-sheets-trigger";
import { instagramCommentTriggerChannel } from "./channels/instagram-comment-trigger";
import { instagramReplyChannel } from "./channels/instagram-reply-comment";
import { youtubeCommentTriggerChannel } from "./channels/youtube-comment-trigger";
import { youtubeReplyChannel } from "./channels/youtube-reply-comment";
import { aiReplyGeneratorChannel } from "./channels/ai-reply-generator";
import { aiTextChannel } from "./channels/ai-text";

export const executeWorkflow = inngest.createFunction(
  { 
    id: "execute-workflow",
    retries: process.env.NODE_ENV === "production" ? 3 : 0,
    onFailure: async ({ event, step }) => {
      return prisma.execution.update({
        where: { inngestEventId: event.data.event.id },
        data: {
          status: ExecutionStatus.FAILED,
          error: event.data.error.message,
          errorStack: event.data.error.stack,
        },
      });
    },
  },
  { 
    event: "workflows/execute.workflow",
    channels: [
      httpRequestChannel(),
      conditionChannel(),
      manualTriggerChannel(),
      googleFormTriggerChannel(),
      typeformTriggerChannel(),
      geminiChannel(),
      openAiChannel(),
      anthropicChannel(),
      discordChannel(),
      slackChannel(),
      notionChannel(),
      telegramActionChannel(),
      telegramTriggerChannel(),
      whatsappActionChannel(),
      gmailActionChannel(),
      gmailTriggerChannel(),
      googleSheetsActionChannel(),
      googleSheetsTriggerChannel(),
      instagramCommentTriggerChannel(),
      instagramReplyChannel(),
      youtubeCommentTriggerChannel(),
      youtubeReplyChannel(),
      aiReplyGeneratorChannel(),
      aiTextChannel(),
    ],
  },
  async ({ event, step, publish }) => {
    const inngestEventId = event.id;
    const { workflowId, initialData, idempotencyKey } = event.data as {
      workflowId?: string;
      // Keep this loose because this JSON is stored directly in Prisma.
      initialData?: any;
      idempotencyKey?: string;
    };

    if (!inngestEventId || !workflowId) {
      throw new NonRetriableError("Event ID or workflow ID is missing");
    }

    if (idempotencyKey) {
      const existing = await step.run("check-idempotency", async () => {
        return prisma.execution.findUnique({
          where: { idempotencyKey },
          select: { id: true, status: true },
        });
      });

      if (existing) {
        return {
          skipped: true,
          reason: "duplicate",
          existingExecutionId: existing.id,
        };
      }
    }

    await step.run("create-execution", async () => {
      return prisma.execution.create({
        data: {
          workflowId,
          inngestEventId,
          idempotencyKey: idempotencyKey ?? null,
        },
      });
    });

    const sortedNodes = await step.run("prepare-workflow", async () => {
      const workflow = await prisma.workflow.findUniqueOrThrow({
        where: { id: workflowId },
        include: {
          nodes: true,
          connections: true,
        },
      });

      return topologicalSort(workflow.nodes, workflow.connections);
    });

    const userId = await step.run("find-user-id", async () => {
      const workflow = await prisma.workflow.findUniqueOrThrow({
        where: { id: workflowId },
        select: {
          userId: true,
        },
      });

      return workflow.userId;
    });

    // Initialize context with any initial data from the trigger
    let context = initialData || {};

    // Execute each node
    for (const node of sortedNodes) {
      const executor = getExecutor(node.type as NodeType);
      context = await executor({
        data: node.data as Record<string, unknown>,
        nodeId: node.id,
        userId,
        context,
        step,
        publish,
      });
    }

    await step.run("update-execution", async () => {
      return prisma.execution.update({
        where: { inngestEventId, workflowId },
        data: {
          status: ExecutionStatus.SUCCESS,
          completedAt: new Date(),
          output: context,
        },
      })
    });

    return {
      workflowId,
      result: context,
    };
  },
);

export const pollYoutubeComments = inngest.createFunction(
  { id: "poll-youtube-comments", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const polls = await step.run("fetch-polls", async () => {
      return prisma.youtubeCommentPoll.findMany({
        include: {
          workflow: {
            include: { nodes: true },
          },
        },
      });
    });

    for (const poll of polls) {
      await step.run(`poll-${poll.videoId}-${poll.workflowId}`, async () => {
        const comments = await fetchNewYoutubeComments(
          poll.userId,
          poll.videoId,
          new Date(poll.lastChecked),
        );

        for (const comment of comments) {
          const triggerNode = poll.workflow.nodes.find(
            (n) => n.type === "YOUTUBE_COMMENT_TRIGGER",
          );
          if (!triggerNode) continue;

          const nodeData = triggerNode.data as { keywordFilter?: string } | null;
          if (nodeData?.keywordFilter) {
            if (
              !comment.commentText
                .toLowerCase()
                .includes(nodeData.keywordFilter.toLowerCase())
            ) {
              continue;
            }
          }

          await sendWorkflowExecution({
            workflowId: poll.workflowId,
            initialData: {
              commentId: comment.commentId,
              commentText: comment.commentText,
              commenterName: comment.commenterName,
              videoId: comment.videoId,
            },
            idempotencyKey: `youtube:${comment.commentId}`,
          });
        }

        await prisma.youtubeCommentPoll.update({
          where: { id: poll.id },
          data: { lastChecked: new Date() },
        });
      });
    }
  },
);

type GmailListResponse = {
  messages?: Array<{ id: string }>;
};

type GmailMessageResponse = {
  id: string;
  snippet?: string;
  payload?: {
    headers?: Array<{
      name?: string;
      value?: string;
    }>;
  };
};

type GoogleSheetsValuesResponse = {
  values?: string[][];
};

function getHeaderValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string {
  if (!headers) return "";
  const found = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

export const pollGmail = inngest.createFunction(
  { id: "poll-gmail", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const workflows = await step.run("fetch-gmail-workflows", async () => {
      return prisma.workflow.findMany({
        where: {
          nodes: {
            some: {
              type: NodeType.GMAIL_TRIGGER,
            },
          },
        },
        select: {
          id: true,
          userId: true,
        },
      });
    });

    await step.run("ensure-gmail-polls", async () => {
      for (const workflow of workflows) {
        await prisma.gmailPoll.upsert({
          where: { workflowId: workflow.id },
          create: {
            workflowId: workflow.id,
            userId: workflow.userId,
          },
          update: {
            userId: workflow.userId,
          },
        });
      }
    });

    const polls = await step.run("fetch-gmail-polls", async () => {
      return prisma.gmailPoll.findMany({
        select: {
          id: true,
          workflowId: true,
          userId: true,
        },
      });
    });

    for (const poll of polls) {
      await step.run(`poll-gmail-${poll.workflowId}`, async () => {
        let accessToken: string;
        try {
          accessToken = await refreshGoogleTokenIfNeeded(poll.userId);
        } catch {
          return;
        }

        const headers = {
          Authorization: `Bearer ${accessToken}`,
        };

        const list = await ky
          .get("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
            headers,
            searchParams: {
              q: "is:unread",
              maxResults: "10",
            },
          })
          .json<GmailListResponse>();

        for (const msg of list.messages ?? []) {
          const metadataParams = new URLSearchParams();
          metadataParams.set("format", "metadata");
          metadataParams.append("metadataHeaders", "Subject");
          metadataParams.append("metadataHeaders", "From");

          const detail = await ky
            .get(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
              {
                headers,
                searchParams: metadataParams,
              },
            )
            .json<GmailMessageResponse>();

          const subject = getHeaderValue(detail.payload?.headers, "Subject");
          const from = getHeaderValue(detail.payload?.headers, "From");
          const snippet = detail.snippet ?? "";

          await sendWorkflowExecution({
            workflowId: poll.workflowId,
            initialData: {
              gmail: {
                messageId: msg.id,
                subject,
                from,
                snippet,
              },
            },
            idempotencyKey: `gmail:${msg.id}`,
          });

          await ky.post(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/modify`,
            {
              headers: {
                ...headers,
                "Content-Type": "application/json",
              },
              json: {
                removeLabelIds: ["UNREAD"],
              },
            },
          );
        }

        await prisma.gmailPoll.update({
          where: { id: poll.id },
          data: { lastChecked: new Date() },
        });
      });
    }
  },
);

export const pollGoogleSheets = inngest.createFunction(
  { id: "poll-google-sheets", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const polls = await step.run("fetch-google-sheets-polls", async () => {
      return prisma.googleSheetsPoll.findMany({
        select: {
          id: true,
          workflowId: true,
          userId: true,
          spreadsheetId: true,
          sheetName: true,
          lastRowCount: true,
        },
      });
    });

    for (const poll of polls) {
      await step.run(`poll-google-sheets-${poll.workflowId}`, async () => {
        let accessToken: string;
        try {
          accessToken = await refreshGoogleTokenIfNeeded(poll.userId);
        } catch {
          return;
        }

        const a1Range = `${poll.sheetName}!A:ZZ`;
        const valuesResult = await ky
          .get(
            `https://sheets.googleapis.com/v4/spreadsheets/${poll.spreadsheetId}/values/${encodeURIComponent(a1Range)}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            },
          )
          .json<GoogleSheetsValuesResponse>();

        const rows = valuesResult.values ?? [];
        const currentRowCount = rows.length;

        if (currentRowCount > poll.lastRowCount) {
          for (let i = poll.lastRowCount; i < currentRowCount; i++) {
            const rowIndex = i + 1;
            const row = rows[i] ?? [];

            await sendWorkflowExecution({
              workflowId: poll.workflowId,
              initialData: {
                googleSheets: {
                  spreadsheetId: poll.spreadsheetId,
                  sheetName: poll.sheetName,
                  rowIndex,
                  row,
                },
              },
              idempotencyKey: `google_sheets:${poll.spreadsheetId}:${rowIndex}`,
            });
          }
        }

        await prisma.googleSheetsPoll.update({
          where: { id: poll.id },
          data: {
            lastRowCount: currentRowCount,
            lastChecked: new Date(),
          },
        });
      });
    }
  },
);

export const pruneOldExecutions = inngest.createFunction(
  { id: "prune-old-executions", retries: 0 },
  { cron: "0 3 * * *" }, // 3 AM UTC daily
  async ({ step }) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const result = await step.run("delete-old-executions", async () => {
      return prisma.execution.deleteMany({
        where: {
          startedAt: { lt: cutoff },
        },
      });
    });

    return { deletedCount: result.count, cutoff: cutoff.toISOString() };
  },
);
