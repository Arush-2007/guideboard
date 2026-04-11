import { generateSlug } from "random-word-slugs";
import prisma from "@/lib/db";
import type { Node, Edge } from "@xyflow/react";
import { createTRPCRouter, premiumProcedure, protectedProcedure } from "@/trpc/init";
import z from "zod";
import { PAGINATION } from "@/config/constants";
import { NodeType } from "@/generated/prisma";
import { inngest } from "@/inngest/client";
import { sendWorkflowExecution } from "@/inngest/utils";
import { TRPCError } from "@trpc/server";

const ANTHROPIC_WORKFLOW_SYSTEM_PROMPT = `You are a workflow automation builder for an app called Guideboard.
The user describes what they want to automate in plain English.
Return ONLY a valid JSON object, no markdown, no explanation:
{
  "name": string,
  "nodes": Array<{
    "id": string (use short unique ids like n1 n2 n3),
    "type": string (must be exact NodeType enum value),
    "position": { "x": number, "y": number },
    "data": object (valid config for that node type, can be empty {})
  }>,
  "edges": Array<{
    "id": string,
    "source": string (node id),
    "target": string (node id)
  }>
}
Available NodeTypes:
MANUAL_TRIGGER, GOOGLE_FORM_TRIGGER, STRIPE_TRIGGER,
INSTAGRAM_COMMENT_TRIGGER, YOUTUBE_COMMENT_TRIGGER,
GMAIL_TRIGGER, GOOGLE_SHEETS_TRIGGER, TYPEFORM_TRIGGER,
TELEGRAM_TRIGGER, HTTP_REQUEST, AI_TEXT, OPENAI, ANTHROPIC, GEMINI,
AI_REPLY_GENERATOR, DISCORD, SLACK, INSTAGRAM_REPLY_COMMENT,
YOUTUBE_REPLY_COMMENT, WHATSAPP_ACTION, TELEGRAM_ACTION,
NOTION_ACTION, GOOGLE_SHEETS_ACTION, GMAIL_ACTION, CONDITION.
Position nodes left to right: first node x=100, increment x by
300 for each subsequent node, all at y=200.
Always start with a trigger node.
Keep workflows simple — 2 to 4 nodes maximum.`;

const generatedWorkflowSchema = z.object({
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

function stripMarkdownCodeFences(text: string): string {
  let t = text.trim();
  if (!t.startsWith("```")) {
    return t;
  }
  const lines = t.split("\n");
  if (lines[0]?.startsWith("```")) {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "```") {
    lines.pop();
  }
  return lines.join("\n").trim();
}

const NODE_TYPE_VALUES = new Set<string>(Object.values(NodeType));

function assertValidNodeTypes(
  nodes: z.infer<typeof generatedWorkflowSchema>["nodes"],
): void {
  for (const node of nodes) {
    if (!NODE_TYPE_VALUES.has(node.type)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Invalid node type in generated workflow: ${node.type}`,
      });
    }
  }
}

export const workflowsRouter = createTRPCRouter({
  execute: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const workflow = await prisma.workflow.findUniqueOrThrow({
        where: {
          id: input.id,
          userId: ctx.auth.user.id,
        },
      });

      await sendWorkflowExecution({
        workflowId: input.id,
      });

      return workflow;
    }),
  create: premiumProcedure.mutation(({ ctx }) => {
    return prisma.workflow.create({
      data: {
        name: generateSlug(3),
        userId: ctx.auth.user.id,
        nodes: {
          create: {
            type: NodeType.INITIAL,
            position: { x: 0, y: 0 },
            name: NodeType.INITIAL,
          },
        },
      },
    });
  }),
  generateFromPrompt: premiumProcedure
    .input(z.object({ prompt: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "ANTHROPIC_API_KEY is not configured",
        });
      }

      let responseText: string;
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2000,
            system: ANTHROPIC_WORKFLOW_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: input.prompt,
              },
            ],
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Anthropic API error (${res.status}): ${errBody.slice(0, 500)}`,
          });
        }

        const json = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>;
        };
        const block = json.content?.find((c) => c.text);
        if (!block?.text) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Anthropic returned no text content",
          });
        }
        responseText = block.text;
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            e instanceof Error
              ? `Failed to call Anthropic API: ${e.message}`
              : "Failed to call Anthropic API",
        });
      }

      let parsed: z.infer<typeof generatedWorkflowSchema>;
      try {
        const stripped = stripMarkdownCodeFences(responseText);
        const raw = JSON.parse(stripped) as unknown;
        const result = generatedWorkflowSchema.safeParse(raw);
        if (!result.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid workflow JSON: ${result.error.message}`,
          });
        }
        parsed = result.data;
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            e instanceof Error
              ? `Failed to parse generated workflow JSON: ${e.message}`
              : "Failed to parse generated workflow JSON",
        });
      }

      assertValidNodeTypes(parsed.nodes);

      const nodeIds = new Set(parsed.nodes.map((n) => n.id));
      if (nodeIds.size !== parsed.nodes.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Generated workflow has duplicate node ids",
        });
      }

      for (const edge of parsed.edges) {
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Generated workflow has an edge referencing unknown node ids",
          });
        }
      }

      const workflow = await prisma.$transaction(async (tx) => {
        const wf = await tx.workflow.create({
          data: {
            name: parsed.name,
            userId: ctx.auth.user.id,
          },
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

      const nodesForSync = parsed.nodes;

      const youtubeTrigger = nodesForSync.find(
        (n) => n.type === "YOUTUBE_COMMENT_TRIGGER",
      );

      if (youtubeTrigger) {
        const videoId = (
          youtubeTrigger.data as { videoId?: string } | undefined
        )?.videoId;

        if (videoId) {
          await prisma.youtubeCommentPoll.upsert({
            where: {
              workflowId_videoId: { workflowId: workflow.id, videoId },
            },
            update: {},
            create: {
              userId: ctx.auth.user.id,
              workflowId: workflow.id,
              videoId,
              lastChecked: new Date(),
            },
          });
        }
      } else {
        await prisma.youtubeCommentPoll.deleteMany({
          where: { workflowId: workflow.id },
        });
      }

      const googleSheetsTrigger = nodesForSync.find(
        (n) => n.type === "GOOGLE_SHEETS_TRIGGER",
      );

      if (googleSheetsTrigger) {
        const triggerData = (googleSheetsTrigger.data as
          | { spreadsheetId?: string; sheetName?: string }
          | undefined) ?? { spreadsheetId: "", sheetName: "" };

        if (triggerData.spreadsheetId && triggerData.sheetName) {
          await prisma.googleSheetsPoll.upsert({
            where: { workflowId: workflow.id },
            update: {
              userId: ctx.auth.user.id,
              spreadsheetId: triggerData.spreadsheetId,
              sheetName: triggerData.sheetName,
            },
            create: {
              userId: ctx.auth.user.id,
              workflowId: workflow.id,
              spreadsheetId: triggerData.spreadsheetId,
              sheetName: triggerData.sheetName,
            },
          });
        }
      } else {
        await prisma.googleSheetsPoll.deleteMany({
          where: { workflowId: workflow.id },
        });
      }

      return { workflowId: workflow.id };
    }),
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      return prisma.workflow.delete({
        where: {
          id: input.id,
          userId: ctx.auth.user.id,
        },
      })
    }),
  update: protectedProcedure
    .input(
      z.object({ 
        id: z.string(), 
        nodes: z.array(
          z.object({
            id: z.string(),
            type: z.string().nullish(),
            position: z.object({ x: z.number(), y: z.number() }),
            data: z.record(z.string(), z.any()).optional(),
          }),
        ),
        edges: z.array(
          z.object({
            source: z.string(),
            target: z.string(),
            sourceHandle: z.string().nullish(),
            targetHandle: z.string().nullish(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, nodes, edges } = input;

      const workflow = await prisma.workflow.findUniqueOrThrow({
        where: { id, userId: ctx.auth.user.id },
      });

      // Transaction to ensure consistency
      await prisma.$transaction(async (tx) => {
        // Delete existing nodes and connections (cascade deletes connections)
        await tx.node.deleteMany({
          where: { workflowId: id },
        });

        // Create nodes
        await tx.node.createMany({
          data: nodes.map((node) => ({
            id: node.id,
            workflowId: id,
            name: node.type || "unknown",
            type: node.type as NodeType,
            position: node.position,
            data: node.data || {},
          })),
        });

        // Create connections
        await tx.connection.createMany({
          data: edges.map((edge) => ({
            workflowId: id,
            fromNodeId: edge.source,
            toNodeId: edge.target,
            fromOutput: edge.sourceHandle || "main",
            toInput: edge.targetHandle || "main",
          })),
        });

        // Update workflow's updatedAt timestamp
        await tx.workflow.update({
          where: { id },
          data: { updatedAt: new Date() },
        });
      });

      // Sync YoutubeCommentPoll rows for this workflow
      const youtubeTrigger = nodes.find(
        (n) => n.type === "YOUTUBE_COMMENT_TRIGGER",
      );

      if (youtubeTrigger) {
        const videoId = (
          youtubeTrigger.data as { videoId?: string } | undefined
        )?.videoId;

        if (videoId) {
          await prisma.youtubeCommentPoll.upsert({
            where: {
              workflowId_videoId: { workflowId: id, videoId },
            },
            update: {},
            create: {
              userId: ctx.auth.user.id,
              workflowId: id,
              videoId,
              lastChecked: new Date(),
            },
          });
        }
      } else {
        await prisma.youtubeCommentPoll.deleteMany({
          where: { workflowId: id },
        });
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
            where: { workflowId: id },
            update: {
              userId: ctx.auth.user.id,
              spreadsheetId: triggerData.spreadsheetId,
              sheetName: triggerData.sheetName,
            },
            create: {
              userId: ctx.auth.user.id,
              workflowId: id,
              spreadsheetId: triggerData.spreadsheetId,
              sheetName: triggerData.sheetName,
            },
          });
        }
      } else {
        await prisma.googleSheetsPoll.deleteMany({
          where: { workflowId: id },
        });
      }

      return workflow;
    }),
  updateName: protectedProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      return prisma.workflow.update({
        where: { id: input.id, userId: ctx.auth.user.id },
        data: { name: input.name },
      });
    }),
  getOne: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const workflow = await prisma.workflow.findUniqueOrThrow({
        where: { id: input.id, userId: ctx.auth.user.id },
        include: { nodes: true, connections: true },
      });

      // Transform server nodes to react-flow compatible nodes
      const nodes: Node[] = workflow.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: node.position as { x: number, y: number },
        data: (node.data as Record<string, unknown>) || {},
      }));

      // Transform server connections to react-flow compatible edges
      const edges: Edge[] = workflow.connections.map((connection) => ({
        id: connection.id,
        source: connection.fromNodeId,
        target: connection.toNodeId,
        sourceHandle: connection.fromOutput,
        targetHandle: connection.toInput,
      }));

      return {
        id: workflow.id,
        name: workflow.name,
        nodes,
        edges,
      };
    }),
  getMany: protectedProcedure
    .input(
      z.object({
        page: z.number().default(PAGINATION.DEFAULT_PAGE),
        pageSize: z
          .number()
          .min(PAGINATION.MIN_PAGE_SIZE)
          .max(PAGINATION.MAX_PAGE_SIZE)
          .default(PAGINATION.DEFAULT_PAGE_SIZE),
        search: z.string().default(""),
      })
    )
    .query(async ({ ctx, input }) => {
      const { page, pageSize, search } = input;

      const [items, totalCount] = await Promise.all([
        prisma.workflow.findMany({
          skip: (page - 1) * pageSize,
          take: pageSize,
          where: { 
            userId: ctx.auth.user.id,
            name: {
              contains: search,
              mode: "insensitive",
            },
          },
          orderBy: {
            updatedAt: "desc",
          },
        }),
        prisma.workflow.count({
          where: {
            userId: ctx.auth.user.id,
            name: {
              contains: search,
              mode: "insensitive",
            },
          },
        }),
      ]);

      const totalPages = Math.ceil(totalCount / pageSize);
      const hasNextPage = page < totalPages;
      const hasPreviousPage = page > 1;

      return {
        items,
        page,
        pageSize,
        totalCount,
        totalPages,
        hasNextPage,
        hasPreviousPage,
      };
    }),
});
