import z from "zod";
import { NodeType } from "@/generated/prisma";

type AnyZodSchema = z.ZodTypeAny;

const emptyPassthroughSchema = z.object({}).passthrough();

// Shared validation rules (copied from the corresponding dialog.tsx forms)
const plainTextSchema = z.string().min(1, { message: "Field is required" });

const apiPromptSchema = z.object({
  credentialId: z.string().min(1, "Credential is required"),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().min(1, "User prompt is required"),
});

const aiReplyGeneratorSchema = z
  .object({
    keyword: z.string().optional(),
    replyToKeywordComments: z.boolean().optional(),
    keywordPrompt: z.string().optional(),
    replyToNonKeywordComments: z.boolean().optional(),
    defaultPrompt: z.string().optional(),
    postDescription: z.string().optional(),
    xaiCredentialId: z.string().optional(),
    geminiCredentialId: z.string().optional(),
    openaiCredentialId: z.string().optional(),
  })
  .passthrough();

const httpRequestSchema = z
  .object({
    endpoint: z.string().min(1, { message: "Please enter a valid URL" }),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    body: z.string().optional(),
  })
  .passthrough();

const conditionSchema = z
  .object({
    field: z.string().min(1, "Field path is required"),
    operator: z.enum([
      "contains",
      "not_contains",
      "equals",
      "not_equals",
      "greater_than",
      "less_than",
      "is_empty",
      "is_not_empty",
    ]),
    value: z.string().optional(),
    stopOnFail: z.boolean().default(true),
  })
  .passthrough();

const openAiFamilySchema = apiPromptSchema.passthrough();

const aiTextSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "gemini"]),
    credentialId: z.string().min(1, "Credential is required"),
    systemPrompt: z.string().optional(),
    prompt: z.string().min(1, "Prompt is required"),
  })
  .passthrough();

const youtubeReplySchema = z
  .object({
    replyMessage: z.string().min(1, "Reply message is required"),
  })
  .passthrough();

const instagramReplySchema = youtubeReplySchema;

const youtubeCommentTriggerSchema = z
  .object({
    videoId: z.string().optional(),
    keywordFilter: z.string().optional(),
  })
  .passthrough();

const instagramCommentTriggerSchema = z
  .object({
    postId: z.string().optional(),
    keywordFilter: z.string().optional(),
  })
  .passthrough();

const discordSchema = z
  .object({
    username: z.string().optional(),
    content: z
      .string()
      .min(1, "Message content is required")
      .max(2000, "Discord messages cannot exceed 2000 characters"),
    webhookUrl: z.string().min(1, "Webhook URL is required"),
  })
  .passthrough();

const slackSchema = z
  .object({
    content: z.string().min(1, "Message content is required"),
    webhookUrl: z.string().min(1, "Webhook URL is required"),
  })
  .passthrough();

const telegramActionSchema = z
  .object({
    credentialId: z.string().min(1, "Credential is required"),
    chatId: z.string().min(1, "Chat ID is required"),
    message: z
      .string()
      .min(1, "Message is required")
      .max(4096, "Telegram messages cannot exceed 4096 characters"),
  })
  .passthrough();

const notionActionSchema = z
  .object({
    credentialId: z.string().min(1, "Credential is required"),
    action: z.enum(["create_page", "append_to_database"]),
    pageTitle: plainTextSchema.min(1, "Page title is required"),
    content: plainTextSchema.min(1, "Content is required"),
    parentPageId: z.string().optional(),
    databaseId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === "create_page") {
      if (!data.parentPageId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Parent page ID is required",
          path: ["parentPageId"],
        });
      }
    } else if (!data.databaseId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Database ID is required",
        path: ["databaseId"],
      });
    }
  })
  .passthrough();

const whatsappActionSchema = z
  .object({
    recipientPhone: z.string().min(1, "Recipient phone number is required"),
    message: z
      .string()
      .min(1, "Message is required")
      .max(4096, "WhatsApp messages cannot exceed 4096 characters"),
  })
  .passthrough();

const gmailActionSchema = z
  .object({
    to: z.string().min(1, "To is required"),
    subject: z.string().min(1, "Subject is required"),
    body: z.string().min(1, "Body is required"),
  })
  .passthrough();

const googleSheetsTriggerSchema = z
  .object({
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Sheet Name is required"),
  })
  .passthrough();

// Shared "match the columns" mapping shape: target field/column -> template
// string (may contain !#path#! placeholders). Reused by any node that maps
// upstream data onto named targets.
const mappingSchema = z.record(z.string(), z.string());

const googleSheetsActionSchema = z
  .object({
    action: z.enum(["append_row", "read_rows"]),
    spreadsheetId: z.string().min(1, "Spreadsheet is required"),
    sheetName: z.string().min(1, "Sheet Name is required"),
    range: z.string().optional(),
    values: z.string().optional(),
    columnMappings: mappingSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === "read_rows") {
      if (!data.range?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Range is required to read rows",
          path: ["range"],
        });
      }
      return;
    }
    // append_row: need a column mapping (preferred) or a legacy values array.
    const hasMappings = data.columnMappings
      ? Object.values(data.columnMappings).some((v) => v.trim())
      : false;
    if (!hasMappings && !data.values?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Map at least one column to append a row",
        path: ["columnMappings"],
      });
    }
  })
  .passthrough();

// One schema per NodeType (must not guess field names)
const nodeConfigSchemas: Record<NodeType, AnyZodSchema> = {
  [NodeType.INITIAL]: emptyPassthroughSchema,
  [NodeType.HTTP_REQUEST]: httpRequestSchema,
  [NodeType.MANUAL_TRIGGER]: emptyPassthroughSchema,
  [NodeType.GOOGLE_FORM_TRIGGER]: emptyPassthroughSchema,
  [NodeType.TYPEFORM_TRIGGER]: emptyPassthroughSchema,
  [NodeType.GMAIL_TRIGGER]: emptyPassthroughSchema,
  [NodeType.GOOGLE_SHEETS_TRIGGER]: googleSheetsTriggerSchema,
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: instagramCommentTriggerSchema,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: instagramReplySchema,
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: youtubeCommentTriggerSchema,
  [NodeType.YOUTUBE_REPLY_COMMENT]: youtubeReplySchema,
  [NodeType.AI_REPLY_GENERATOR]: aiReplyGeneratorSchema,
  [NodeType.AI_TEXT]: aiTextSchema,
  [NodeType.ANTHROPIC]: openAiFamilySchema,
  [NodeType.CONDITION]: conditionSchema,
  [NodeType.GEMINI]: openAiFamilySchema,
  [NodeType.OPENAI]: openAiFamilySchema,
  [NodeType.DISCORD]: discordSchema,
  [NodeType.SLACK]: slackSchema,
  [NodeType.NOTION_ACTION]: notionActionSchema,
  [NodeType.TELEGRAM_ACTION]: telegramActionSchema,
  [NodeType.TELEGRAM_TRIGGER]: emptyPassthroughSchema,
  [NodeType.WHATSAPP_ACTION]: whatsappActionSchema,
  [NodeType.GMAIL_ACTION]: gmailActionSchema,
  [NodeType.GOOGLE_SHEETS_ACTION]: googleSheetsActionSchema,
};

export function parseNodeConfig(type: NodeType, data: unknown) {
  const schema = nodeConfigSchemas[type];
  if (!schema) {
    throw new Error(`No node config schema registered for NodeType="${type}"`);
  }

  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");

  throw new Error(
    `Invalid node.data for NodeType="${type}": ${issues || "unknown Zod error"}`,
  );
}
