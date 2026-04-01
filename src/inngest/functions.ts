import { NonRetriableError } from "inngest";
import { inngest } from "./client";
import prisma from "@/lib/db";
import { topologicalSort, sendWorkflowExecution } from "./utils";
import { ExecutionStatus, NodeType } from "@/generated/prisma";
import { getExecutor } from "@/features/executions/lib/executor-registry";
import { fetchNewYoutubeComments } from "@/lib/youtube-comments";
import { httpRequestChannel } from "./channels/http-request";
import { manualTriggerChannel } from "./channels/manual-trigger";
import { googleFormTriggerChannel } from "./channels/google-form-trigger";
import { stripeTriggerChannel } from "./channels/stripe-trigger";
import { geminiChannel } from "./channels/gemini";
import { openAiChannel } from "./channels/openai";
import { anthropicChannel } from "./channels/anthropic";
import { discordChannel } from "./channels/discord";
import { slackChannel } from "./channels/slack";
import { instagramCommentTriggerChannel } from "./channels/instagram-comment-trigger";
import { instagramReplyChannel } from "./channels/instagram-reply-comment";
import { youtubeCommentTriggerChannel } from "./channels/youtube-comment-trigger";
import { youtubeReplyChannel } from "./channels/youtube-reply-comment";
import { aiReplyGeneratorChannel } from "./channels/ai-reply-generator";

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
      manualTriggerChannel(),
      googleFormTriggerChannel(),
      stripeTriggerChannel(),
      geminiChannel(),
      openAiChannel(),
      anthropicChannel(),
      discordChannel(),
      slackChannel(),
      instagramCommentTriggerChannel(),
      instagramReplyChannel(),
      youtubeCommentTriggerChannel(),
      youtubeReplyChannel(),
      aiReplyGeneratorChannel(),
    ],
  },
  async ({ event, step, publish }) => {
    const inngestEventId = event.id;
    const workflowId = event.data.workflowId;

    if (!inngestEventId || !workflowId) {
      throw new NonRetriableError("Event ID or workflow ID is missing");
    }

    await step.run("create-execution", async () => {
      return prisma.execution.create({
        data: {
          workflowId,
          inngestEventId,
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
    let context = event.data.initialData || {};

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
