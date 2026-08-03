import { TRPCError } from "@trpc/server";
import z from "zod";
import type { Prisma } from "@/generated/prisma";
import { describeStrippedRefs } from "@/lib/dangling-refs";
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

GOOGLE_SHEETS_ACTION supports four actions in its data: "append_row",
"find_rows", "update_row" and "style_cells". find_rows, update_row and
style_cells select rows with an AND-ed "conditions" array. find_rows with no
conditions reads every row of the tab; every column is always returned.
update_row overwrites the mapped columns of every row matching its conditions;
unmapped columns keep their current value. update_row REQUIRES at least one
condition (an empty filter would overwrite the whole sheet), and it never adds a
row — when nothing matches it does nothing and reports "matched": false.

append_row adds a new row. Its "position" field chooses WHERE: "bottom" (the
default) adds the row at the bottom of the tab; "under_group" and "under_each"
add the row INSIDE a group instead — use these for a tab whose rows are grouped
(every job for a customer kept together). Both "under_*" positions REQUIRE at
least one condition — the conditions pick the group. "under_group" adds ONE row
directly under the LAST matching row, i.e. below the group as a whole;
"under_each" adds one row below EVERY matching row and then runs the steps after
it once per added row (capped by "maxFanOutItems"). When nothing matches, one row
starts a new group at the bottom of the tab.

style_cells FORMATS the rows its conditions select — use it whenever the user
wants rows flagged, highlighted, color-coded, bolded, resized, or merged. It does
NOT use "columnMappings". It takes:
  - "cellFormat": any subset of { "bold", "italic", "underline",
    "strikethrough", "fontSize" (6-48), "textColor": "#RRGGBB",
    "backgroundColor": "#RRGGBB", "align": "LEFT"|"CENTER"|"RIGHT",
    "verticalAlign": "TOP"|"MIDDLE"|"BOTTOM" }.
    ⚠️ ONLY include the properties the user actually asked for. An omitted
    property means "leave the cells exactly as they are" — adding one the user
    did not ask for would overwrite formatting they applied by hand. So "make
    overdue rows red" is { "backgroundColor": "#fee2e2" } and NOTHING else.
  - "mergeMode": "none" (default), "merge" (join the cells into ONE — this is
    how a section-title row is made) or "unmerge".
  - "styleColumns": optional array of header names to narrow the band. Omit it
    for the whole row, which is what merging a section title needs.
  - "onMultipleStyleMatches": "all" (default — style every match), "first"
    (topmost only) or "last" (bottom-most only).
It REQUIRES at least one condition (an empty filter would restyle the whole tab)
and must set at least one "cellFormat" property or a non-"none" "mergeMode".
It branches "styled" / "no_match".

SECTION TITLES / HEADINGS. There is no separate heading action. A heading is
simply a row whose cells are MERGED, and a merged row holds exactly ONE value —
Sheets keeps only the top-left cell when it merges.

To CREATE one, use append_row with "styleAppendedRow": true, "mergeMode":
"merge", "mergedText" (the title itself, REQUIRED), and a "cellFormat" such as
{ "bold": true, "align": "CENTER" }. ⚠️ Do NOT send "columnMappings" for a merged
row — it takes "mergedText" INSTEAD of a mapping, because 15 of 16 mapped
columns would be discarded by the merge. append_row's "position" and "conditions"
work exactly as above, so a title can go at the bottom, under a group, or under
every matching row, and "mergedText" may reference "@<anchorRow.COLUMN>@".

To FIND, UPDATE or RESTYLE an existing heading, use the ordinary actions with a
condition whose "column" is the special value "__merged_row__". That pseudo-column
matches ONLY rows whose cells are merged, and compares against the merged cell's
text with any normal operator. Examples:
  find a section:    find_rows,  conditions: [{ "column": "__merged_row__",
                     "operator": "contains", "value": "March" }]
  rename a section:  update_row, the same condition + columnMappings on the
                     tab's FIRST column (that is the cell a merged row keeps)
  recolour sections: style_cells, the same condition + a "cellFormat"
⚠️ A filter is one of exactly two things, and "__merged_row__" is what decides
which:
  - names it     ⇒ matches ONLY merged rows (section titles).
  - doesn't name it ⇒ matches only ORDINARY rows; merged rows are EXCLUDED.
So a condition on "__merged_row__" is the ONLY way to reach a section title, and
an ordinary filter can never touch one by accident — which matters most on
update_row, where "Status is_empty" would otherwise match every section title
(their non-first cells read as empty) and overwrite them. Use "__merged_row__"
whenever the user talks about sections, titles, headings or dividers.
It can only NARROW to merged rows, never exclude them: "__merged_row__" with
"not_contains" still returns merged rows only.

In an "under_*" append's columnMappings, "@<anchorRow.COLUMN>@" resolves to a
cell of the row the new row is placed under, so a new row can copy values from
the row above it (e.g. "Service Buyer": "@<anchorRow.Service Buyer>@").

find_rows and update_row both accept "onMultipleMatches": "first" (default —
find_rows continues with the topmost matching row; update_row updates it),
"last" (the same, on the bottom-most matching row instead — use it for
"the latest/most recent entry" when rows are added in order),
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

        const { workflowId, danglingRefs } = await persistGeneratedWorkflow(
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

        // The model's own success message, plus a note about anything the
        // persist step had to clear. Appended rather than replacing it: the
        // workflow WAS built, and the note is about one or two fields in it.
        const note = describeStrippedRefs(danglingRefs);

        return {
          reply: note ? `${parsed.message}\n\n${note}` : parsed.message,
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
