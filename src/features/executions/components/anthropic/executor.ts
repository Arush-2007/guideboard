import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import { describeProviderError } from "@/features/executions/lib/provider-error";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { timeoutSignal } from "@/lib/http";
import { renderTemplate } from "@/lib/templating";

type AnthropicData = {
  credentialId?: string;
  systemPrompt?: string;
  userPrompt?: string;
};

export const anthropicExecutor: NodeExecutor<AnthropicData> = async ({
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

  let config: AnthropicData;
  try {
    config = parseNodeConfig(NodeType.ANTHROPIC, data) as AnthropicData;
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

  const systemPrompt = config.systemPrompt
    ? renderTemplate(config.systemPrompt, context)
    : "You are a helpful assistant.";
  const userPrompt = renderTemplate(config.userPrompt, context);
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
    throw new NonRetriableError("Anthropic node: Credential not found");
  }

  const anthropic = createAnthropic({
    apiKey: decrypt(credential.value),
  });

  try {
    const { steps } = await step.ai.wrap(
      "anthropic-generate-text",
      generateText,
      {
        model: anthropic("claude-sonnet-4-5"),
        system: systemPrompt,
        prompt: userPrompt,
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: true,
          recordOutputs: true,
        },
        // The AI SDK has NO default timeout and silently retries twice, so a
        // wedged provider would hang the step until the platform killed it.
        // Inngest owns retrying (backoff, isolation, a visible run record).
        abortSignal: timeoutSignal("LLM"),
        maxRetries: 0,
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
        text,
      },
    };
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw describeProviderError(error, "Anthropic");
  }
};
