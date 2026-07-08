import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import { describeProviderError } from "@/features/executions/lib/provider-error";
import type { NodeExecutor } from "@/features/executions/types";
import { CredentialType, NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { renderTemplate } from "@/lib/templating";

type AiTextProvider = "openai" | "anthropic" | "gemini" | "groq";

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
  groq: CredentialType.GROQ,
};

const providerLabel: Record<AiTextProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  groq: "Groq",
};

export const aiTextExecutor: NodeExecutor<AiTextData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: AiTextData;
  try {
    config = parseNodeConfig(NodeType.AI_TEXT, data) as AiTextData;
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({
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
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("AI Text node: Provider is required");
  }
  const expectedCredentialType = providerToCredentialType[provider];

  const systemPrompt = config.systemPrompt
    ? renderTemplate(config.systemPrompt, context)
    : "You are a helpful assistant.";
  const userPrompt = renderTemplate(config.prompt, context);
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
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("AI Text node: Credential not found");
  }

  if (credential.type !== expectedCredentialType) {
    await publish(
      nodeStatusChannel(userId).status({
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
          : provider === "gemini"
            ? {
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
              }
            : {
                model: createGroq({
                  apiKey: decrypt(credential.value),
                })("llama-3.3-70b-versatile"),
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
      nodeStatusChannel(userId).status({
        nodeId,
        status: "success",
      }),
    );

    return {
      ...context,
      [outputKey]: {
        // The AI node's result, referenced downstream as
        // @<ai_text_<id>.output>@ (declared in node-outputs.ts).
        output: text,
      },
    };
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw describeProviderError(error, providerLabel[provider]);
  }
};
