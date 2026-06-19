import { NonRetriableError } from "inngest";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { NodeExecutor } from "@/features/executions/types";
import { aiReplyGeneratorChannel } from "@/inngest/channels/ai-reply-generator";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

type AiReplyGeneratorData = {
  keyword?: string;
  replyToKeywordComments?: boolean;
  keywordPrompt?: string;
  replyToNonKeywordComments?: boolean;
  defaultPrompt?: string;
  postDescription?: string;
  xaiCredentialId?: string;
  geminiCredentialId?: string;
  openaiCredentialId?: string;
  groqCredentialId?: string;
};

type ResolvedCredential = {
  apiKey: string;
  provider: "xai" | "gemini" | "openai" | "groq";
  model: string;
  accountDescription: string | null;
  replyTone: string | null;
  replyGoal: string | null;
};

export const aiReplyGeneratorExecutor: NodeExecutor<AiReplyGeneratorData> =
  async ({ data, nodeId, userId, context, step, publish }) => {
    await publish(
      aiReplyGeneratorChannel().status({ nodeId, status: "loading" }),
    );

    let config: AiReplyGeneratorData;
    try {
      config = parseNodeConfig(NodeType.AI_REPLY_GENERATOR, data) as AiReplyGeneratorData;
    } catch (error) {
      await publish(
        aiReplyGeneratorChannel().status({ nodeId, status: "error" }),
      );
      throw new NonRetriableError(
        error instanceof Error ? error.message : "Invalid node config",
      );
    }

    // ── Keyword routing ──────────────────────────────────────────────────────
    const commentText = (context.commentText as string | undefined) ?? "";
    const keyword = config.keyword?.trim();
    const hasKeyword = Boolean(
      keyword && commentText.toLowerCase().includes(keyword.toLowerCase()),
    );

    // Default both toggles to true when undefined (matches dialog defaults)
    const replyToKeyword = config.replyToKeywordComments !== false;
    const replyToNonKeyword = config.replyToNonKeywordComments !== false;

    let activeInstruction: string | undefined;
    let shouldSkip = false;

    if (hasKeyword) {
      if (replyToKeyword) {
        activeInstruction = config.keywordPrompt;
      } else {
        shouldSkip = true;
      }
    } else {
      if (replyToNonKeyword) {
        activeInstruction = config.defaultPrompt;
      } else {
        shouldSkip = true;
      }
    }

    if (shouldSkip) {
      await publish(
        aiReplyGeneratorChannel().status({ nodeId, status: "success" }),
      );
      return context;
    }

    // ── Credential + settings resolution ────────────────────────────────────
    const resolved = await step.run(
      "resolve-credential-and-settings",
      async (): Promise<ResolvedCredential> => {
        const settings = await prisma.aiReplySettings.findUnique({
          where: { userId },
        });

        const tryCredential = async (id: string | undefined) => {
          if (!id) return null;
          return prisma.credential.findUnique({ where: { id, userId } });
        };

        const xaiCred = await tryCredential(config.xaiCredentialId);
        if (xaiCred) {
          return {
            apiKey: decrypt(xaiCred.value),
            provider: "xai",
            model: "grok-3-mini",
            accountDescription: settings?.accountDescription ?? null,
            replyTone: settings?.replyTone ?? null,
            replyGoal: settings?.replyGoal ?? null,
          };
        }

        const geminiCred = await tryCredential(config.geminiCredentialId);
        if (geminiCred) {
          return {
            apiKey: decrypt(geminiCred.value),
            provider: "gemini",
            model: "gemini-2.0-flash",
            accountDescription: settings?.accountDescription ?? null,
            replyTone: settings?.replyTone ?? null,
            replyGoal: settings?.replyGoal ?? null,
          };
        }

        const openaiCred = await tryCredential(config.openaiCredentialId);
        if (openaiCred) {
          return {
            apiKey: decrypt(openaiCred.value),
            provider: "openai",
            model: "gpt-4o-mini",
            accountDescription: settings?.accountDescription ?? null,
            replyTone: settings?.replyTone ?? null,
            replyGoal: settings?.replyGoal ?? null,
          };
        }

        const groqCred = await tryCredential(config.groqCredentialId);
        if (groqCred) {
          return {
            apiKey: decrypt(groqCred.value),
            provider: "groq",
            model: "llama-3.3-70b-versatile",
            accountDescription: settings?.accountDescription ?? null,
            replyTone: settings?.replyTone ?? null,
            replyGoal: settings?.replyGoal ?? null,
          };
        }

        throw new NonRetriableError(
          "AI Reply Generator node: No valid credential found. Add at least one AI credential (xAI, Gemini, OpenAI, or Groq).",
        );
      },
    );

    // ── Build prompts ────────────────────────────────────────────────────────
    const baseURLMap: Record<
      ResolvedCredential["provider"],
      string | undefined
    > = {
      xai: "https://api.x.ai/v1",
      gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
      openai: undefined,
      groq: "https://api.groq.com/openai/v1",
    };

    const aiProvider = createOpenAI({
      apiKey: resolved.apiKey,
      baseURL: baseURLMap[resolved.provider],
    });

    const systemPromptLines = [
      "You are a social media manager.",
      `Account description: ${resolved.accountDescription ?? "Not provided"}`,
      `Reply tone: ${resolved.replyTone ?? "friendly"}`,
      `Reply goal: ${resolved.replyGoal ?? "Be helpful and engaging"}`,
      config.postDescription
        ? `Post/video context: ${config.postDescription}`
        : null,
      "Keep replies concise, natural, and under 200 characters.",
      activeInstruction
        ? `Your specific instruction: ${activeInstruction}`
        : null,
    ];

    const systemPrompt = systemPromptLines.filter(Boolean).join("\n");

    const commenterName =
      (context.commenterName as string | undefined) ?? "someone";

    const userPrompt = [
      "Generate a reply to this comment:",
      `Commenter: ${commenterName}`,
      `Comment: ${commentText}`,
      "Reply only with the message text, nothing else.",
    ].join("\n");

    // ── AI generation ────────────────────────────────────────────────────────
    try {
      const { steps } = await step.ai.wrap(
        "ai-reply-generator-generate",
        generateText,
        {
          model: aiProvider(resolved.model),
          system: systemPrompt,
          prompt: userPrompt,
          experimental_telemetry: {
            isEnabled: true,
            recordInputs: true,
            recordOutputs: true,
          },
        },
      );

      const generatedReply =
        steps[0]?.content[0]?.type === "text"
          ? steps[0].content[0].text
          : "";

      await publish(
        aiReplyGeneratorChannel().status({ nodeId, status: "success" }),
      );

      return {
        ...context,
        aiReply: { text: generatedReply },
      };
    } catch (error) {
      await publish(
        aiReplyGeneratorChannel().status({ nodeId, status: "error" }),
      );
      throw error;
    }
  };
