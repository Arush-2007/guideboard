import z from "zod";
import { NodeType } from "@/generated/prisma";

type AnyZodSchema = z.ZodTypeAny;

const emptyPassthroughSchema = z.object({}).passthrough();

// Shared validation rules (copied from the corresponding dialog.tsx forms)
const variableNameSchema = z
  .string()
  .min(1, { message: "Variable name is required" })
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
    message:
      "Must start with a letter or underscore and contain only letters, numbers, and underscores",
  });

const discordVariableNameSchema = z
  .string()
  .min(1, { message: "Variable name is required" })
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
    message:
      "Variable name must start with a letter or underscore and container only letters, numbers, and underscores",
  });

const apiPromptSchema = z.object({
  variableName: variableNameSchema,
  credentialId: z.string().min(1, "Credential is required"),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().min(1, "User prompt is required"),
});

const aiReplyGeneratorSchema = z
  .object({
    variableName: variableNameSchema,
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
    variableName: variableNameSchema,
    endpoint: z
      .string()
      .min(1, { message: "Please enter a valid URL" }),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    body: z.string().optional(),
  })
  .passthrough();

const openAiFamilySchema = apiPromptSchema.passthrough();

const youtubeReplySchema = z
  .object({
    replyMessage: z.string().min(1, "Reply message is required"),
    variableName: variableNameSchema,
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
    replyMessage: z.string().min(1, "Reply message is required"),
  })
  .passthrough();

const discordSchema = z
  .object({
    variableName: discordVariableNameSchema,
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
    variableName: discordVariableNameSchema,
    content: z.string().min(1, "Message content is required"),
    webhookUrl: z.string().min(1, "Webhook URL is required"),
  })
  .passthrough();

// One schema per NodeType (must not guess field names)
const nodeConfigSchemas: Record<NodeType, AnyZodSchema> = {
  [NodeType.INITIAL]: emptyPassthroughSchema,
  [NodeType.HTTP_REQUEST]: httpRequestSchema,
  [NodeType.MANUAL_TRIGGER]: emptyPassthroughSchema,
  [NodeType.GOOGLE_FORM_TRIGGER]: emptyPassthroughSchema,
  [NodeType.STRIPE_TRIGGER]: emptyPassthroughSchema,
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: instagramCommentTriggerSchema,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: instagramReplySchema,
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: youtubeCommentTriggerSchema,
  [NodeType.YOUTUBE_REPLY_COMMENT]: youtubeReplySchema,
  [NodeType.AI_REPLY_GENERATOR]: aiReplyGeneratorSchema,
  [NodeType.GEMINI]: openAiFamilySchema,
  [NodeType.OPENAI]: openAiFamilySchema,
  [NodeType.ANTHROPIC]: openAiFamilySchema,
  [NodeType.DISCORD]: discordSchema,
  [NodeType.SLACK]: slackSchema,
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

