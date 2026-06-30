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
    groqCredentialId: z.string().optional(),
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
    field: z.string().min(1, "Field is required"),
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
  })
  .passthrough();

const switchSchema = z
  .object({
    cases: z
      .array(
        z.object({
          id: z.string().min(1),
          field: z.string().min(1, "Field is required"),
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
        }),
      )
      .optional(),
  })
  .passthrough();

const openAiFamilySchema = apiPromptSchema.passthrough();

const aiTextSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "gemini", "groq"]),
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
    // Array of webhook URLs (new, fan-out) and/or a legacy single `webhookUrl`.
    webhookUrls: z.array(z.string()).optional(),
    webhookUrl: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const hasList = (data.webhookUrls ?? []).some((u) => u.trim());
    const hasLegacy = !!data.webhookUrl?.trim();
    if (!hasList && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add at least one webhook URL",
        path: ["webhookUrls"],
      });
    }
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
    // Array of recipients (new, fan-out) and/or a legacy single phone number.
    recipientPhones: z.array(z.string()).optional(),
    recipientPhone: z.string().optional(),
    message: z
      .string()
      .min(1, "Message is required")
      .max(4096, "WhatsApp messages cannot exceed 4096 characters"),
  })
  .superRefine((data, ctx) => {
    const hasList = (data.recipientPhones ?? []).some((p) => p.trim());
    const hasLegacy = !!data.recipientPhone?.trim();
    if (!hasList && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add at least one recipient",
        path: ["recipientPhones"],
      });
    }
  })
  .passthrough();

const gmailActionSchema = z
  .object({
    // Array of recipients (new) or a legacy comma-separated string.
    to: z.union([
      z.array(z.string().min(1)).min(1, "Add at least one recipient"),
      z.string().min(1, "To is required"),
    ]),
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

// Deep cron/timezone validity is enforced at save time (the dialog preview +
// `syncTriggerPollsForWorkflow`, both via `isValidSchedule`). Here we only
// require the two fields to be present so `cron-parser` stays out of every
// import path of this module; the executor just needs a configured schedule.
const scheduleTriggerSchema = z
  .object({
    cron: z.string().min(1, "Schedule is required"),
    timezone: z.string().min(1, "Timezone is required"),
  })
  .passthrough();

// Shared "match the columns" mapping shape: target field/column -> template
// string (may contain @<path>@ placeholders). Reused by any node that maps
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

const compareOperatorEnum = z.enum([
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "is_empty",
  "is_not_empty",
]);

const resumeParserSchema = z
  .object({
    provider: z.enum(["builtin", "affinda"]).optional(),
    sourceUrl: z.string().min(1, "Resume URL is required"),
    skillKeywords: z.string().optional(),
    credentialId: z.string().optional(),
    workspaceId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.provider === "affinda" && !data.credentialId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An Affinda credential is required",
        path: ["credentialId"],
      });
    }
  })
  .passthrough();

const candidateScoringSchema = z
  .object({
    provider: z.enum(["rules", "affinda"]).optional(),
    shortlistThreshold: z.coerce.number().optional(),
    reviewThreshold: z.coerce.number().optional(),
    rules: z
      .array(
        z.object({
          id: z.string().optional(),
          label: z.string().optional(),
          field: z.string().min(1, "Field is required"),
          operator: compareOperatorEnum,
          value: z.string().optional(),
          points: z.coerce.number(),
          required: z.boolean().optional(),
        }),
      )
      .optional(),
    credentialId: z.string().optional(),
    jobDescriptionId: z.string().optional(),
    resumeId: z.string().optional(),
    indexName: z.string().optional(),
    weights: z.record(z.string(), z.number()).optional(),
  })
  .superRefine((data, ctx) => {
    const provider = data.provider ?? "rules";
    if (provider === "rules") {
      if (!data.rules || data.rules.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Add at least one scoring rule",
          path: ["rules"],
        });
      }
    } else {
      if (!data.credentialId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An Affinda credential is required",
          path: ["credentialId"],
        });
      }
      if (!data.jobDescriptionId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A job description id is required",
          path: ["jobDescriptionId"],
        });
      }
    }
  })
  .passthrough();

const atsActionSchema = z
  .object({
    provider: z.enum(["lever"]).optional(),
    environment: z.enum(["sandbox", "production"]).optional(),
    credentialId: z.string().min(1, "A credential is required"),
    performAsUserId: z.string().min(1, "A 'perform as' user id is required"),
    name: z.string().min(1, "Candidate name is required"),
    email: z.string().optional(),
    resumeUrl: z.string().optional(),
    note: z.string().optional(),
    stageId: z.string().optional(),
    postingId: z.string().optional(),
  })
  .passthrough();

// Generic Typeform trigger config: the connected credential, selected form, and
// its discovered fields (each `{ path, label }` so the variable picker can expose
// them). No domain-specific (HR) fields — any workflow can consume the responses.
const typeformTriggerSchema = z
  .object({
    credentialId: z.string().optional(),
    formId: z.string().optional(),
    formTitle: z.string().optional(),
    discoveredFields: z
      .array(z.object({ path: z.string(), label: z.string() }))
      .optional(),
  })
  .passthrough();

// Generic Google Form trigger config: the selected form + its discovered
// questions (each `{ path, label }` so the variable picker can expose them).
// No domain-specific (HR) fields — any workflow can consume the raw responses.
const googleFormTriggerSchema = z
  .object({
    formId: z.string().optional(),
    formTitle: z.string().optional(),
    discoveredFields: z
      .array(z.object({ path: z.string(), label: z.string() }))
      .optional(),
  })
  .passthrough();

// One schema per NodeType (must not guess field names)
const nodeConfigSchemas: Record<NodeType, AnyZodSchema> = {
  [NodeType.INITIAL]: emptyPassthroughSchema,
  [NodeType.HTTP_REQUEST]: httpRequestSchema,
  [NodeType.MANUAL_TRIGGER]: emptyPassthroughSchema,
  [NodeType.GOOGLE_FORM_TRIGGER]: googleFormTriggerSchema,
  [NodeType.TYPEFORM_TRIGGER]: typeformTriggerSchema,
  [NodeType.GMAIL_TRIGGER]: emptyPassthroughSchema,
  [NodeType.GOOGLE_SHEETS_TRIGGER]: googleSheetsTriggerSchema,
  [NodeType.SCHEDULE_TRIGGER]: scheduleTriggerSchema,
  // Token + secret live in the WebhookTrigger table (server-owned), so the node
  // itself carries no user config.
  [NodeType.WEBHOOK_TRIGGER]: emptyPassthroughSchema,
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: instagramCommentTriggerSchema,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: instagramReplySchema,
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: youtubeCommentTriggerSchema,
  [NodeType.YOUTUBE_REPLY_COMMENT]: youtubeReplySchema,
  [NodeType.AI_REPLY_GENERATOR]: aiReplyGeneratorSchema,
  [NodeType.AI_TEXT]: aiTextSchema,
  [NodeType.ANTHROPIC]: openAiFamilySchema,
  [NodeType.CONDITION]: conditionSchema,
  [NodeType.SWITCH]: switchSchema,
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
  [NodeType.RESUME_PARSER]: resumeParserSchema,
  [NodeType.CANDIDATE_SCORING]: candidateScoringSchema,
  [NodeType.ATS_ACTION]: atsActionSchema,
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
