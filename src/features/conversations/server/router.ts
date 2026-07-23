import { TRPCError } from "@trpc/server";
import z from "zod";
import type { Prisma } from "@/generated/prisma";
import prisma from "@/lib/db";
import { isTimeout, timeoutSignal } from "@/lib/http";
import {
  generatedWorkflowSchema,
  persistGeneratedWorkflow,
  validateGeneratedWorkflowGraph,
} from "@/lib/workflow-persistence";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

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
INSTAGRAM_COMMENT_TRIGGER, YOUTUBE_COMMENT_TRIGGER,
GMAIL_TRIGGER, GOOGLE_SHEETS_TRIGGER, TYPEFORM_TRIGGER,
SCHEDULE_TRIGGER, TELEGRAM_TRIGGER, HTTP_REQUEST, AI_TEXT, AI_REPLY_GENERATOR,
DISCORD, SLACK, INSTAGRAM_REPLY_COMMENT, YOUTUBE_REPLY_COMMENT,
WHATSAPP_ACTION, TELEGRAM_ACTION, NOTION_ACTION, 
GOOGLE_SHEETS_ACTION, GMAIL_ACTION, EXCEL_ACTION, CONDITION, CONVERT.

GOOGLE_SHEETS_ACTION supports eight actions in its data: "append_row",
"append_heading", "find_rows", "find_heading", "update_row", "update_heading",
"color_rows" and "color_heading". find_rows and update_row select rows with an AND-ed
"conditions" array. find_rows with no conditions reads every row of the tab;
every column is always returned. update_row overwrites the mapped columns of
every row matching its conditions; unmapped columns keep their current value.
update_row REQUIRES at least one condition (an empty filter would overwrite the
whole sheet), and it never adds a row — when nothing matches it does nothing and
reports "matched": false.

append_row adds a new row. Its "position" field chooses WHERE: "bottom" (the
default) adds the row at the bottom of the tab; "under_group" and "under_each"
add the row INSIDE a group instead — use these for a tab whose rows are grouped
(every job for a customer kept together). Both "under_*" positions REQUIRE at
least one condition — the conditions pick the group. "under_group" adds ONE row
directly under the LAST matching row, i.e. below the group as a whole;
"under_each" adds one row below EVERY matching row and then runs the steps after
it once per added row (capped by "maxFanOutItems"). When nothing matches, one row
starts a new group at the bottom of the tab.

append_heading adds a SECTION TITLE row: one piece of text ("headingText") in a
row whose cells are merged into a single band across the tab's columns. Use it
when the user wants a title, section header or divider label in the sheet rather
than a data row. It uses "position" and "conditions" exactly like append_row (so
a heading can go at the bottom, under a group, or under every matching row), but
it has NO "columnMappings" — "headingText" is required. Optional "headingFormat"
sets { "bold", "italic", "fontSize", "textColor": "#RRGGBB",
"backgroundColor": "#RRGGBB", "align": "LEFT"|"CENTER"|"RIGHT" }; omit it for a
bold, centered, black-on-white heading.

find_heading searches ONLY the heading rows added by append_heading, and never
returns an ordinary data row. Use it whenever the user wants to find, check for,
or locate a section title. It takes an optional "headingFilter":
{ "operator": "equals"|"contains"|"not_equals"|"not_contains", "value": "..." };
omit the value to return every heading on the tab. Matching ignores
capitalisation. It branches "found" / "notfound" and reports "firstHeading",
"headings", "headingRowIndexes" and "rowIndex".

update_heading renames a section title; color_heading paints matching section
titles one "headingColor" ("#RRGGBB"). Both take the same optional
"headingFilter" as find_heading. update_heading needs "headingText" (the new
text); it rewrites ONE heading and reports "previousHeading" alongside
"headingText". PREFER text-only renames: only set "restyleHeading": true when
the user explicitly asks to change how the heading LOOKS, and when you do you
MUST also supply the full "headingFormat" they asked for — restyling re-applies
that format, so turning it on without one would overwrite the heading's existing
styling (and is rejected).

IMPORTANT: heading rows are NEVER selected by a filter written against your
columns. find_rows, update_row and color_rows all skip them by default, so a
filter that happens to equal a heading's text will not return, overwrite or
paint it. To reach a heading use find_heading / update_heading / color_heading,
or set "rowScope" to "headings" on update_row or color_rows (its values are
"data" — the default — "headings", and "all").

In an "under_*" append's columnMappings, "@<anchorRow.COLUMN>@" resolves to a
cell of the row the new row is placed under, so a new row can copy values from
the row above it (e.g. "Service Buyer": "@<anchorRow.Service Buyer>@").

color_rows paints matching rows a background color — use it when the user wants
rows flagged, highlighted or color-coded. It does NOT use "conditions" or
"columnMappings". Instead it takes "colorRules": an ORDERED array of
{ "color": "#RRGGBB", "conditions": [...] }. Every row is checked against the
rules top to bottom and the FIRST matching rule wins, so a row is colored once
however many rules it matches. Every rule REQUIRES at least one condition (a rule
with an empty filter would color the whole tab). Rows are colored across their
used columns, up to the last header. It branches "colored" / "no_match".

find_rows and update_row both accept "onMultipleMatches": "first" (default —
find_rows continues with the first matching row; update_row updates it),
"each" (run the steps after it once per matching row, each in its own run —
update_row also writes every matched row; optional "maxFanOutItems" caps the
runs, default 100), or "error" (fail the run when more than one row matches).
Use "each" when the user wants to act on every matching row (e.g. "send an
email for each overdue order").

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
          // Was an UNBOUNDED fetch: a slow generation would hang the chat request
          // until the platform killed it. This runs in tRPC with a human watching, so
          // a timeout becomes a TRPCError the chat panel can render — an Inngest
          // RetryAfterError would be meaningless here.
          signal: timeoutSignal("LLM"),
        }).catch((error: unknown) => {
          if (isTimeout(error)) {
            throw new TRPCError({
              code: "TIMEOUT",
              message:
                "Claude took too long to respond. Please send your message again.",
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

        validateGeneratedWorkflowGraph(wfParsed.nodes, wfParsed.edges);

        const { workflowId } = await persistGeneratedWorkflow(
          ctx.auth.user.id,
          wfParsed,
        );

        await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            phase: "BUILDING",
            workflowId,
          },
        });

        return {
          reply: parsed.message,
          phase: "BUILDING" as const,
          workflowId,
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
