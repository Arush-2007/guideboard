import { NonRetriableError } from "inngest";
import ky from "ky";
import { ExecutionStatus, NodeType, type Prisma } from "@/generated/prisma";
import prisma from "@/lib/db";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { fetchNewYoutubeComments } from "@/lib/youtube-comments";
import { inngest } from "./client";
import { runWorkflowNodes } from "./run-workflow";
import { sendWorkflowExecution, topologicalSort } from "./utils";

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
    // Realtime publish is provided by realtimeMiddleware() on the inngest client
    // (src/inngest/client.ts), so channels don't need to be declared here. Each
    // executor publishes to its own user-scoped channel, e.g.
    // `anthropicChannel(userId).status(...)`.
    event: "workflows/execute.workflow",
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

    const { sortedNodes, userId } = await step.run(
      "prepare-workflow",
      async () => {
        const workflow = await prisma.workflow.findUniqueOrThrow({
          where: { id: workflowId },
          include: {
            nodes: true,
            connections: true,
          },
        });

        return {
          sortedNodes: topologicalSort(workflow.nodes, workflow.connections),
          userId: workflow.userId,
        };
      },
    );

    // Run each node sequentially, threading context from one to the next.
    const context = await runWorkflowNodes({
      sortedNodes,
      userId,
      initialData,
      step,
      publish,
    });

    await step.run("update-execution", async () => {
      return prisma.execution.update({
        where: { inngestEventId, workflowId },
        data: {
          status: ExecutionStatus.SUCCESS,
          completedAt: new Date(),
          output: context as Prisma.InputJsonObject,
        },
      });
    });

    return {
      workflowId,
      result: context,
    };
  },
);

// Dispatcher: enumerates poll rows (ids only) and fans out one
// `polls/youtube.check` event per row. The per-poll work (external API calls,
// workflow dispatch, lastChecked update) lives in `handleYoutubePoll`, which
// runs with its own retries + concurrency cap so one poll can't block another.
export const pollYoutubeComments = inngest.createFunction(
  { id: "poll-youtube-comments", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const polls = await step.run("fetch-poll-ids", async () => {
      return prisma.youtubeCommentPoll.findMany({ select: { id: true } });
    });

    if (polls.length === 0) return { dispatched: 0 };

    await step.sendEvent(
      "dispatch-youtube-polls",
      polls.map((poll) => ({
        name: "polls/youtube.check",
        data: { pollId: poll.id },
      })),
    );

    return { dispatched: polls.length };
  },
);

// Handler: processes a single YouTube comment poll. Fetches only this
// workflow's trigger node (not every node of every workflow), runs with its
// own retries + concurrency cap so one poll's failure/slowness can't block the
// rest. Duplicate workflow runs are prevented by the `youtube:<commentId>`
// idempotency key on each execution.
export const handleYoutubePoll = inngest.createFunction(
  { id: "handle-youtube-poll", retries: 1, concurrency: { limit: 20 } },
  { event: "polls/youtube.check" },
  async ({ event, step }) => {
    const { pollId } = event.data as { pollId: string };

    await step.run("process-youtube-poll", async () => {
      const poll = await prisma.youtubeCommentPoll.findUnique({
        where: { id: pollId },
        include: {
          workflow: {
            include: {
              nodes: { where: { type: NodeType.YOUTUBE_COMMENT_TRIGGER } },
            },
          },
        },
      });
      if (!poll) return;

      const triggerNode = poll.workflow.nodes[0];
      if (!triggerNode) return;

      const comments = await fetchNewYoutubeComments(
        poll.userId,
        poll.videoId,
        new Date(poll.lastChecked),
      );

      for (const comment of comments) {
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

// Dispatcher: poll rows are provisioned/cleaned up by `syncTriggerPollsForWorkflow`
// (src/lib/workflow-persistence.ts) on every workflow create/edit, so each row
// here corresponds to a live Gmail trigger. Per-poll work lives in
// `handleGmailPoll`.
export const pollGmail = inngest.createFunction(
  { id: "poll-gmail", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const polls = await step.run("fetch-gmail-poll-ids", async () => {
      return prisma.gmailPoll.findMany({ select: { id: true } });
    });

    if (polls.length === 0) return { dispatched: 0 };

    await step.sendEvent(
      "dispatch-gmail-polls",
      polls.map((poll) => ({
        name: "polls/gmail.check",
        data: { pollId: poll.id },
      })),
    );

    return { dispatched: polls.length };
  },
);

// Handler: processes a single Gmail poll (token refresh + unread scan + N
// metadata fetches). Isolated retries + concurrency cap; duplicate runs are
// prevented by the `gmail:<messageId>` idempotency key and the mark-as-read.
export const handleGmailPoll = inngest.createFunction(
  { id: "handle-gmail-poll", retries: 1, concurrency: { limit: 20 } },
  { event: "polls/gmail.check" },
  async ({ event, step }) => {
    const { pollId } = event.data as { pollId: string };

    await step.run("process-gmail-poll", async () => {
      const poll = await prisma.gmailPoll.findUnique({
        where: { id: pollId },
        select: { id: true, workflowId: true, userId: true },
      });
      if (!poll) return;

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
  },
);

// Dispatcher: fans out one `polls/google-sheets.check` event per poll row.
// Per-poll work lives in `handleGoogleSheetsPoll`.
export const pollGoogleSheets = inngest.createFunction(
  { id: "poll-google-sheets", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const polls = await step.run("fetch-google-sheets-poll-ids", async () => {
      return prisma.googleSheetsPoll.findMany({ select: { id: true } });
    });

    if (polls.length === 0) return { dispatched: 0 };

    await step.sendEvent(
      "dispatch-google-sheets-polls",
      polls.map((poll) => ({
        name: "polls/google-sheets.check",
        data: { pollId: poll.id },
      })),
    );

    return { dispatched: polls.length };
  },
);

// Handler: processes a single Google Sheets poll. Diffs current row count
// against `lastRowCount` and emits one execution per new row. Isolated retries
// + concurrency cap; duplicate runs are prevented by the
// `google_sheets:<spreadsheetId>:<rowIndex>` idempotency key.
export const handleGoogleSheetsPoll = inngest.createFunction(
  { id: "handle-google-sheets-poll", retries: 1, concurrency: { limit: 20 } },
  { event: "polls/google-sheets.check" },
  async ({ event, step }) => {
    const { pollId } = event.data as { pollId: string };

    await step.run("process-google-sheets-poll", async () => {
      const poll = await prisma.googleSheetsPoll.findUnique({
        where: { id: pollId },
        select: {
          id: true,
          workflowId: true,
          userId: true,
          spreadsheetId: true,
          sheetName: true,
          lastRowCount: true,
        },
      });
      if (!poll) return;

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
