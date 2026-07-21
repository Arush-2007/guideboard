import { TRPCError } from "@trpc/server";
import type { Edge } from "@xyflow/react";
import z from "zod";
import { PAGINATION } from "@/config/constants";
import type { NodeType } from "@/generated/prisma";
import { sendWorkflowExecution } from "@/inngest/utils";
import prisma from "@/lib/db";
import { isTimeout, timeoutSignal } from "@/lib/http";
import { logger } from "@/lib/logger";
import {
  legacyOutputKey,
  resolveNodeRefs,
  rewriteRefsInJson,
  stripRefFromData,
} from "@/lib/node-ref";
import {
  assertNoEdgeIntoTrigger,
  generatedWorkflowSchema,
  persistGeneratedWorkflow,
  syncTriggerPollsForWorkflow,
  validateGeneratedWorkflowGraph,
} from "@/lib/workflow-persistence";
import {
  createTRPCRouter,
  premiumProcedure,
  protectedProcedure,
} from "@/trpc/init";

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
MANUAL_TRIGGER, GOOGLE_FORM_TRIGGER,
INSTAGRAM_COMMENT_TRIGGER, YOUTUBE_COMMENT_TRIGGER,
GMAIL_TRIGGER, GOOGLE_SHEETS_TRIGGER, TYPEFORM_TRIGGER,
SCHEDULE_TRIGGER, TELEGRAM_TRIGGER, HTTP_REQUEST, AI_TEXT, OPENAI, ANTHROPIC, GEMINI,
AI_REPLY_GENERATOR, DISCORD, SLACK, INSTAGRAM_REPLY_COMMENT,
YOUTUBE_REPLY_COMMENT, WHATSAPP_ACTION, TELEGRAM_ACTION,
NOTION_ACTION, GOOGLE_SHEETS_ACTION, GMAIL_ACTION, CONDITION.
Position nodes left to right: first node x=100, increment x by
300 for each subsequent node, all at y=200.
Always start with a trigger node.
Keep workflows simple — 2 to 4 nodes maximum.`;

function stripMarkdownCodeFences(text: string): string {
  const t = text.trim();
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
  create: premiumProcedure
    .input(z.object({ name: z.string().trim().min(1, "Name is required") }))
    .mutation(({ ctx, input }) => {
      return prisma.workflow.create({
        data: {
          name: input.name.trim(),
          userId: ctx.auth.user.id,
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
          // Was an UNBOUNDED fetch: a slow generation would hang the request until
          // the platform killed it. tRPC with a human waiting, so a timeout becomes a
          // TRPCError the UI can render.
          signal: timeoutSignal("LLM"),
        }).catch((error: unknown) => {
          if (isTimeout(error)) {
            throw new TRPCError({
              code: "TIMEOUT",
              message:
                "Claude took too long to generate the workflow. Please try again.",
            });
          }
          throw error;
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

      validateGeneratedWorkflowGraph(parsed.nodes, parsed.edges);

      return persistGeneratedWorkflow(ctx.auth.user.id, parsed);
    }),
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      return prisma.workflow.delete({
        where: {
          id: input.id,
          userId: ctx.auth.user.id,
        },
      });
    }),
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        nodes: z.array(
          z.object({
            id: z.string(),
            type: z.string().nullish(),
            // The canvas carries a node's ref inside `data.ref` (see `RefCarrier`
            // in lib/node-ref.ts); there is no separate top-level ref field.
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

      // The canvas can't draw an edge into a trigger, but that guard is
      // client-side — this is the server door for the same invariant, so a
      // scripted client can't persist a graph the engine would mis-run.
      assertNoEdgeIntoTrigger(nodes, edges);

      // Snapshot existing refs by node id BEFORE we replace the rows. The save
      // is a full delete+recreate, so we recover each node's frozen `ref` by its
      // (stable) id; new ref-eligible nodes get the next number. This keeps refs
      // stable across saves even if the client doesn't round-trip them.
      const existingRefs = await prisma.node.findMany({
        where: { workflowId: id },
        select: { id: true, ref: true },
      });
      const refById = new Map(existingRefs.map((n) => [n.id, n.ref]));

      // First pass: resolve each node's final ref and map its legacy `<type>_<id>`
      // output key to it. The ref a client claims lives in `data.ref` and wins
      // over the stored column (that's how a rename lands), but it is NOT
      // trusted blind: `resolveNodeRefs` guarantees the batch is collision-free,
      // because a duplicate would otherwise fail the whole save on
      // `@@unique([workflowId, ref])` with a raw Prisma error.
      const { refByNodeId, reassigned } = resolveNodeRefs(nodes, refById);
      if (reassigned.length > 0) {
        logger.warn("Reassigned duplicate node refs on save", {
          workflowId: id,
          reassigned,
        });
      }

      const legacyKeyToRef = new Map<string, string>();
      for (const node of nodes) {
        const ref = refByNodeId.get(node.id);
        if (ref && node.type) {
          legacyKeyToRef.set(legacyOutputKey(node.type, node.id), ref);
        }
      }

      // Second pass: rewrite any legacy `<type>_<id>` references in each node's
      // data to the now-assigned refs. A downstream node that referenced this
      // node before it had a ref (e.g. a picked `discoveredFields` path) stored
      // the legacy key; at run time the producer writes under its ref, so without
      // this rewrite the reference would resolve to nothing. (Mirrors the AI
      // builder's `persistGeneratedWorkflow`.)
      const nodeCreateData = nodes.map((node) => ({
        id: node.id,
        workflowId: id,
        name: node.type || "unknown",
        type: node.type as NodeType,
        ref: refByNodeId.get(node.id) ?? null,
        position: node.position,
        // The ref rides in `data` only as the canvas's carrier; `stripRefFromData`
        // keeps it out of the persisted blob so it can't drift from the column.
        data: JSON.parse(
          rewriteRefsInJson(
            JSON.stringify(stripRefFromData(node.data)),
            legacyKeyToRef,
          ),
        ),
      }));

      // Transaction to ensure consistency
      await prisma.$transaction(async (tx) => {
        // Delete existing nodes and connections (cascade deletes connections)
        await tx.node.deleteMany({
          where: { workflowId: id },
        });

        // Create nodes
        await tx.node.createMany({
          data: nodeCreateData,
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

      // Keep trigger poll rows in sync with the workflow's current nodes.
      await syncTriggerPollsForWorkflow(ctx.auth.user.id, id, nodes);

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

      // Transform server nodes to react-flow compatible nodes. The `ref` is
      // injected INTO `data` because that is the only field React Flow hands to
      // a node component and the only one the editor's history preserves — see
      // `RefCarrier` in lib/node-ref.ts. It is stored in its own `Node.ref`
      // column (which carries the uniqueness constraint), never in the persisted
      // `data` blob, so this is the one place the two views are joined; `update`
      // lifts it back out on the way in.
      const nodes = workflow.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: node.position as { x: number; y: number },
        data: {
          ...((node.data as Record<string, unknown>) || {}),
          ...(node.ref ? { ref: node.ref } : {}),
        },
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
      }),
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
