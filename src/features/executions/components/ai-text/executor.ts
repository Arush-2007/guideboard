import Handlebars from "handlebars";
import { NonRetriableError } from "inngest";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { NodeExecutor } from "@/features/executions/types";
import { aiTextChannel } from "@/inngest/channels/ai-text";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { CredentialType, NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

Handlebars.registerHelper("json", (context) => {
  const jsonString = JSON.stringify(context, null, 2);
  const safeString = new Handlebars.SafeString(jsonString);

  return safeString;
});

type AiTextProvider = "openai" | "anthropic" | "gemini";

type AiTextData = {
  provider?: AiTextProvider;
  credentialId?: string;
  systemPrompt?: string;
  prompt?: string;
};

const providerToCredentialType: Record<AiTextProvider, CredentialType> = {
  openai: CredentialType.OPENAI,
  anthropic: CredentialType.ANTHROPIC,
  gemini: CredentialType.GEMINI,
};

export const aiTextExecutor: NodeExecutor<AiTextData> = async ({
  data,
  nodeId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    aiTextChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: AiTextData;
  try {
    config = parseNodeConfig(NodeType.AI_TEXT, data) as AiTextData;
  } catch (error) {
    await publish(
      aiTextChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const provider = config.provider;
  if (!provider) {
    await publish(
      aiTextChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("AI Text node: Provider is required");
  }
  const expectedCredentialType = providerToCredentialType[provider];

  const systemPrompt = config.systemPrompt
    ? Handlebars.compile(config.systemPrompt)(context)
    : "You are a helpful assistant.";
  const userPrompt = Handlebars.compile(config.prompt)(context);
  const outputKey = `${NodeType.AI_TEXT.toLowerCase()}_${nodeId}`;

  const credential = await step.run("get-credential", () => {
    return prisma.credential.findUnique({
      where: {
        id: config.credentialId,
        userId,
      },
    });
  });

  if (!credential) {
    await publish(
      aiTextChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("AI Text node: Credential not found");
  }

  if (credential.type !== expectedCredentialType) {
    await publish(
      aiTextChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      "AI Text node: Credential does not match selected provider",
    );
  }

  try {
    const { steps } = await step.ai.wrap(
      `${provider}-generate-text`,
      generateText,
      provider === "openai"
        ? {
            model: createOpenAI({
              apiKey: decrypt(credential.value),
            })("gpt-4"),
            system: systemPrompt,
            prompt: userPrompt,
            experimental_telemetry: {
              isEnabled: true,
              recordInputs: true,
              recordOutputs: true,
            },
          }
        : provider === "anthropic"
          ? {
              model: createAnthropic({
                apiKey: decrypt(credential.value),
              })("claude-sonnet-4-5"),
              system: systemPrompt,
              prompt: userPrompt,
              experimental_telemetry: {
                isEnabled: true,
                recordInputs: true,
                recordOutputs: true,
              },
            }
          : {
              model: createGoogleGenerativeAI({
                apiKey: decrypt(credential.value),
              })("gemini-2.0-flash"),
              system: systemPrompt,
              prompt: userPrompt,
              experimental_telemetry: {
                isEnabled: true,
                recordInputs: true,
                recordOutputs: true,
              },
            },
    );

    const text =
      steps[0].content[0].type === "text" ? steps[0].content[0].text : "";

    await publish(
      aiTextChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return {
      ...context,
      [outputKey]: {
        text,
      },
    };
  } catch (error) {
    await publish(
      aiTextChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
