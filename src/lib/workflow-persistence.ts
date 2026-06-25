import { TRPCError } from "@trpc/server";
import z from "zod";
import { NodeType } from "@/generated/prisma";
import prisma from "@/lib/db";
import { computeNextRunAt, isValidSchedule } from "@/lib/schedule";

/**
 * Shared persistence + validation for AI-generated workflows.
 *
 * Both the manual prompt builder (`workflows.generateFromPrompt`) and the
 * conversational builder (`conversations.chat`) turn an LLM response into the
 * same `{ name, nodes, edges }` shape and persist it identically. This module
 * is the single source of truth for that shape, its integrity checks, the
 * create transaction, and trigger-poll syncing, so a fix in one path can't
 * silently diverge from the other.
 */

export const generatedWorkflowSchema = z.object({
  name: z.string().min(1),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string(),
        position: z.object({ x: z.number(), y: z.number() }),
        data: z.record(z.string(), z.any()).optional(),
      }),
    )
    .min(1)
    .max(8),
  edges: z.array(
    z.object({
      id: z.string().optional(),
      source: z.string().min(1),
      target: z.string().min(1),
    }),
  ),
});

export type GeneratedWorkflow = z.infer<typeof generatedWorkflowSchema>;
export type GeneratedNode = GeneratedWorkflow["nodes"][number];

const NODE_TYPE_VALUES = new Set<string>(Object.values(NodeType));

/**
 * Validates a generated graph beyond what the Zod schema covers: every node
 * type is a real `NodeType`, node ids are unique, and every edge references
 * known nodes. Throws `TRPCError(BAD_REQUEST)` on the first violation.
 */
export function validateGeneratedWorkflowGraph(
  nodes: GeneratedNode[],
  edges: GeneratedWorkflow["edges"],
): void {
  for (const node of nodes) {
    if (!NODE_TYPE_VALUES.has(node.type)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Invalid node type in generated workflow: ${node.type}`,
      });
    }
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  if (nodeIds.size !== nodes.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Generated workflow has duplicate node ids",
    });
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Generated workflow has an edge referencing unknown node ids",
      });
    }
  }
}

/**
 * Persists a validated generated workflow (workflow + nodes + connections) in
 * a single transaction, then syncs its trigger poll rows. Returns the new
 * workflow id.
 */
export async function persistGeneratedWorkflow(
  userId: string,
  parsed: GeneratedWorkflow,
): Promise<{ workflowId: string }> {
  const workflow = await prisma.$transaction(async (tx) => {
    const wf = await tx.workflow.create({
      data: { name: parsed.name, userId },
    });

    await tx.node.createMany({
      data: parsed.nodes.map((node) => ({
        id: node.id,
        workflowId: wf.id,
        name: node.type,
        type: node.type as NodeType,
        position: node.position,
        data: node.data ?? {},
      })),
    });

    if (parsed.edges.length > 0) {
      await tx.connection.createMany({
        data: parsed.edges.map((edge) => ({
          workflowId: wf.id,
          fromNodeId: edge.source,
          toNodeId: edge.target,
          fromOutput: "main",
          toInput: "main",
        })),
      });
    }

    return wf;
  });

  await syncTriggerPollsForWorkflow(userId, workflow.id, parsed.nodes);

  return { workflowId: workflow.id };
}

/** Node shape needed for poll syncing — works for both generated and edited nodes. */
type SyncableNode = { type?: string | null; data?: unknown };

/**
 * Reconciles the polling-trigger tables (`YoutubeCommentPoll`, `GmailPoll`,
 * `GoogleSheetsPoll`, `SchedulePoll`) with the trigger nodes present in a
 * workflow: upserts a poll row when the matching trigger exists and is
 * configured, and removes stale rows when it doesn't. Called on every create
 * and edit so the cron pollers in `src/inngest/functions.ts` see an accurate
 * set of work.
 */
export async function syncTriggerPollsForWorkflow(
  userId: string,
  workflowId: string,
  nodes: SyncableNode[],
): Promise<void> {
  const youtubeTrigger = nodes.find(
    (n) => n.type === "YOUTUBE_COMMENT_TRIGGER",
  );

  if (youtubeTrigger) {
    const videoId = (youtubeTrigger.data as { videoId?: string } | undefined)
      ?.videoId;

    if (videoId) {
      await prisma.youtubeCommentPoll.upsert({
        where: { workflowId_videoId: { workflowId, videoId } },
        update: {},
        create: {
          userId,
          workflowId,
          videoId,
          lastChecked: new Date(),
        },
      });
    }
  } else {
    await prisma.youtubeCommentPoll.deleteMany({ where: { workflowId } });
  }

  // Gmail triggers carry no per-trigger config (the poller always reads the
  // user's unread inbox), so presence of the node alone provisions the row.
  const gmailTrigger = nodes.find((n) => n.type === "GMAIL_TRIGGER");

  if (gmailTrigger) {
    await prisma.gmailPoll.upsert({
      where: { workflowId },
      update: { userId },
      create: { userId, workflowId },
    });
  } else {
    await prisma.gmailPoll.deleteMany({ where: { workflowId } });
  }

  const googleSheetsTrigger = nodes.find(
    (n) => n.type === "GOOGLE_SHEETS_TRIGGER",
  );

  if (googleSheetsTrigger) {
    const triggerData = (googleSheetsTrigger.data as
      | { spreadsheetId?: string; sheetName?: string }
      | undefined) ?? { spreadsheetId: "", sheetName: "" };

    if (triggerData.spreadsheetId && triggerData.sheetName) {
      await prisma.googleSheetsPoll.upsert({
        where: { workflowId },
        update: {
          userId,
          spreadsheetId: triggerData.spreadsheetId,
          sheetName: triggerData.sheetName,
        },
        create: {
          userId,
          workflowId,
          spreadsheetId: triggerData.spreadsheetId,
          sheetName: triggerData.sheetName,
        },
      });
    }
  } else {
    await prisma.googleSheetsPoll.deleteMany({ where: { workflowId } });
  }

  const scheduleTrigger = nodes.find((n) => n.type === "SCHEDULE_TRIGGER");

  if (scheduleTrigger) {
    const data = scheduleTrigger.data as
      | { cron?: string; timezone?: string }
      | undefined;
    const cron = data?.cron;
    const timezone = data?.timezone;

    if (cron && timezone && isValidSchedule(cron, timezone)) {
      // Only recompute `nextRunAt` when the cron/timezone actually changed, so
      // an unrelated edit to the workflow doesn't shift an already-scheduled
      // firing. A new or retimed schedule gets its next run computed from now.
      const existing = await prisma.schedulePoll.findUnique({
        where: { workflowId },
        select: { cron: true, timezone: true },
      });
      const unchanged =
        existing?.cron === cron && existing?.timezone === timezone;

      if (unchanged) {
        await prisma.schedulePoll.update({
          where: { workflowId },
          data: { userId },
        });
      } else {
        const nextRunAt = computeNextRunAt(cron, timezone);
        await prisma.schedulePoll.upsert({
          where: { workflowId },
          update: { userId, cron, timezone, nextRunAt },
          create: { userId, workflowId, cron, timezone, nextRunAt },
        });
      }
    } else {
      // Trigger present but not validly configured yet — no poll row.
      await prisma.schedulePoll.deleteMany({ where: { workflowId } });
    }
  } else {
    await prisma.schedulePoll.deleteMany({ where: { workflowId } });
  }
}
