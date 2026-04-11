import prisma from "@/lib/db";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";
import { TRPCError } from "@trpc/server";
import z from "zod";
import { NodeType, type Prisma } from "@/generated/prisma";

const ANTHROPIC_CONVERSATION_SYSTEM_PROMPT = `You are Guideboard AI, a conversational workflow automation builder.
Your job is to help users build automations through natural conversation.

You operate in phases:
GATHERING: Ask clarifying questions to understand what the user wants.
  - Ask one question at a time, never multiple at once
  - Once you understand the trigger, actions, and integrations needed, 
    move to CONFIRMING
CONFIRMING: Present a clear summary of the workflow you will build.
  - Format: 'I will build: [Trigger] → [Action 1] → [Action 2]'
  - Ask: 'Does this sound right?'
  - If user says yes/correct/looks good → move to BUILDING
  - If user wants changes → go back to GATHERING
BUILDING: Generate the workflow JSON and confirm it was created.

Available NodeTypes: MANUAL_TRIGGER, GOOGLE_FORM_TRIGGER, 
STRIPE_TRIGGER, INSTAGRAM_COMMENT_TRIGGER, YOUTUBE_COMMENT_TRIGGER,
GMAIL_TRIGGER, GOOGLE_SHEETS_TRIGGER, TYPEFORM_TRIGGER,
TELEGRAM_TRIGGER, HTTP_REQUEST, AI_TEXT, AI_REPLY_GENERATOR,
DISCORD, SLACK, INSTAGRAM_REPLY_COMMENT, YOUTUBE_REPLY_COMMENT,
WHATSAPP_ACTION, TELEGRAM_ACTION, NOTION_ACTION, 
GOOGLE_SHEETS_ACTION, GMAIL_ACTION, CONDITION.

When in BUILDING phase, respond with ONLY this JSON:
{
  "phase": "BUILDING",
  "message": "Creating your workflow now...",
  "workflow": {
    "name": string,
    "nodes": Array<{ "id": string, "type": string, "position": { "x": number, "y": number }, "data": {} }>,
    "edges": Array<{ "id": string, "source": string, "target": string }>
  }
}

For all other phases respond with ONLY this JSON:
{
  "phase": "GATHERING" | "CONFIRMING",
  "message": string
}

Position nodes: x starts at 100, increment by 300, y=200.
Always start workflow with a trigger node. Max 4 nodes.
Keep responses concise and friendly.`;

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

const buildingResponseSchema = z.object({
  phase: z.literal("BUILDING"),
  message: z.string(),
  workflow: generatedWorkflowSchema,
});

const conversationalResponseSchema = z.object({
  phase: z.enum(["GATHERING", "CONFIRMING"]),
  message: z.string(),
});

type ChatMessage = { role: "user" | "assistant"; content: string };

const NODE_TYPE_VALUES = new Set<string>(Object.values(NodeType));

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

function parseMessages(json: Prisma.JsonValue): ChatMessage[] {
  if (!Array.isArray(json)) return [];
  const out: ChatMessage[] = [];
  for (const item of json) {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      "role" in item &&
      "content" in item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string"
    ) {
      out.push({ role: item.role, content: item.content });
    }
  }
  return out;
}

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

async function syncTriggerPollsForWorkflow(
  userId: string,
  workflowId: string,
  nodes: z.infer<typeof generatedWorkflowSchema>["nodes"],
) {
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
          workflowId_videoId: { workflowId, videoId },
        },
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
    await prisma.youtubeCommentPoll.deleteMany({
      where: { workflowId },
    });
  }

  const googleSheetsTrigger = nodes.find(
    (n) => n.type === "GOOGLE_SHEETS_TRIGGER",
  );

  if (googleSheetsTrigger) {
    const triggerData =
      (googleSheetsTrigger.data as
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
    await prisma.googleSheetsPoll.deleteMany({
      where: { workflowId },
    });
  }
}

export const conversationsRouter = createTRPCRouter({
  create: protectedProcedure.mutation(async ({ ctx }) => {
    const conversation = await prisma.conversation.create({
      data: {
        userId: ctx.auth.user.id,
        messages: [],
      },
    });

    return { conversationId: conversation.id };
  }),

  chat: protectedProcedure
    .input(
      z.object({
        conversationId: z.string(),
        message: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: input.conversationId,
          userId: ctx.auth.user.id,
        },
      });

      if (!conversation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Conversation not found",
        });
      }

      const messages = parseMessages(conversation.messages);
      messages.push({ role: "user", content: input.message });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          messages: messages as unknown as Prisma.InputJsonValue,
        },
      });

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
            max_tokens: 1000,
            system: ANTHROPIC_CONVERSATION_SYSTEM_PROMPT,
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
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

      messages.push({ role: "assistant", content: responseText });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          messages: messages as unknown as Prisma.InputJsonValue,
        },
      });

      const stripped = stripMarkdownCodeFences(responseText);
      let rawParsed: unknown;
      try {
        rawParsed = JSON.parse(stripped);
      } catch (e) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            e instanceof Error
              ? `Failed to parse assistant JSON: ${e.message}`
              : "Failed to parse assistant JSON",
        });
      }

      const building = buildingResponseSchema.safeParse(rawParsed);
      if (building.success) {
        const parsed = building.data;
        let wfParsed: z.infer<typeof generatedWorkflowSchema>;
        try {
          const result = generatedWorkflowSchema.safeParse(parsed.workflow);
          if (!result.success) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Invalid workflow JSON: ${result.error.message}`,
            });
          }
          wfParsed = result.data;
        } catch (e) {
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              e instanceof Error ? e.message : "Invalid workflow in response",
          });
        }

        assertValidNodeTypes(wfParsed.nodes);

        const nodeIds = new Set(wfParsed.nodes.map((n) => n.id));
        if (nodeIds.size !== wfParsed.nodes.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Generated workflow has duplicate node ids",
          });
        }

        for (const edge of wfParsed.edges) {
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
              name: wfParsed.name,
              userId: ctx.auth.user.id,
            },
          });

          await tx.node.createMany({
            data: wfParsed.nodes.map((node) => ({
              id: node.id,
              workflowId: wf.id,
              name: node.type,
              type: node.type as NodeType,
              position: node.position,
              data: node.data ?? {},
            })),
          });

          if (wfParsed.edges.length > 0) {
            await tx.connection.createMany({
              data: wfParsed.edges.map((edge) => ({
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

        await syncTriggerPollsForWorkflow(
          ctx.auth.user.id,
          workflow.id,
          wfParsed.nodes,
        );

        await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            phase: "BUILDING",
            workflowId: workflow.id,
          },
        });

        return {
          reply: parsed.message,
          phase: "BUILDING" as const,
          workflowId: workflow.id,
        };
      }

      const conversational = conversationalResponseSchema.safeParse(rawParsed);
      if (!conversational.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Invalid assistant response JSON: ${conversational.error.message}`,
        });
      }

      const parsed = conversational.data;

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          phase: parsed.phase,
        },
      });

      return {
        reply: parsed.message,
        phase: parsed.phase,
      };
    }),

  getOne: protectedProcedure
    .input(z.object({ conversationId: z.string() }))
    .query(async ({ ctx, input }) => {
      return prisma.conversation.findFirstOrThrow({
        where: {
          id: input.conversationId,
          userId: ctx.auth.user.id,
        },
      });
    }),
});
