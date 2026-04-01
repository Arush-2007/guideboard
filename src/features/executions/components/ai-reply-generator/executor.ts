import { NonRetriableError } from "inngest";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { NodeExecutor } from "@/features/executions/types";
import { aiReplyGeneratorChannel } from "@/inngest/channels/ai-reply-generator";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";

type AiReplyGeneratorData = {
  variableName?: string;
  keyword?: string;
  replyToKeywordComments?: boolean;
  keywordPrompt?: string;
  replyToNonKeywordComments?: boolean;
  defaultPrompt?: string;
  postDescription?: string;
  xaiCredentialId?: string;
  geminiCredentialId?: string;
  openaiCredentialId?: string;
};

type ResolvedCredential = {
  apiKey: string;
  provider: "xai" | "gemini" | "openai";
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

    if (!data.variableName) {
      await publish(
        aiReplyGeneratorChannel().status({ nodeId, status: "error" }),
      );
      throw new NonRetriableError(
        "AI Reply Generator node: Variable name is required",
      );
    }

    // ── Keyword routing ──────────────────────────────────────────────────────
    const commentText = (context.commentText as string | undefined) ?? "";
    const keyword = data.keyword?.trim();
    const hasKeyword = Boolean(
      keyword && commentText.toLowerCase().includes(keyword.toLowerCase()),
    );

    // Default both toggles to true when undefined (matches dialog defaults)
    const replyToKeyword = data.replyToKeywordComments !== false;
    const replyToNonKeyword = data.replyToNonKeywordComments !== false;

    let activeInstruction: string | undefined;
    let shouldSkip = false;

    if (hasKeyword) {
      if (replyToKeyword) {
        activeInstruction = data.keywordPrompt;
      } else {
        shouldSkip = true;
      }
    } else {
      if (replyToNonKeyword) {
        activeInstruction = data.defaultPrompt;
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
        const settings = await prisma.instagramSettings.findUnique({
          where: { userId },
        });

        const tryCredential = async (id: string | undefined) => {
          if (!id) return null;
          return prisma.credential.findUnique({ where: { id, userId } });
        };

        const xaiCred = await tryCredential(data.xaiCredentialId);
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

        const geminiCred = await tryCredential(data.geminiCredentialId);
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

        const openaiCred = await tryCredential(data.openaiCredentialId);
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

        throw new NonRetriableError(
          "AI Reply Generator node: No valid credential found. Add at least one AI credential (xAI, Gemini, or OpenAI).",
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
      data.postDescription
        ? `Post/video context: ${data.postDescription}`
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
        [data.variableName]: { text: generatedReply },
      };
    } catch (error) {
      await publish(
        aiReplyGeneratorChannel().status({ nodeId, status: "error" }),
      );
      throw error;
    }
  };
