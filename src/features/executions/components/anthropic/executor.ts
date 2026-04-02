import Handlebars from "handlebars";
import { NonRetriableError } from "inngest";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { NodeExecutor } from "@/features/executions/types";
import { anthropicChannel } from "@/inngest/channels/anthropic";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

Handlebars.registerHelper("json", (context) => {
  const jsonString = JSON.stringify(context, null, 2);
  const safeString = new Handlebars.SafeString(jsonString);

  return safeString;
});

type AnthropicData = {
  variableName?: string;
  credentialId?: string;
  systemPrompt?: string;
  userPrompt?: string;
};

export const anthropicExecutor: NodeExecutor<AnthropicData> = async ({
  data,
  nodeId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    anthropicChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: AnthropicData;
  try {
    config = parseNodeConfig(NodeType.ANTHROPIC, data) as AnthropicData;
  } catch (error) {
    await publish(
      anthropicChannel().status({
        nodeId,
        status: "error",
      })
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const systemPrompt = config.systemPrompt
    ? Handlebars.compile(config.systemPrompt)(context)
    : "You are a helpful assistant.";
  const userPrompt = Handlebars.compile(config.userPrompt)(context);

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
      anthropicChannel().status({
        nodeId,
        status: "error",
      })
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
      },
    );

    const text = 
      steps[0].content[0].type === "text" 
        ? steps[0].content[0].text
        : "";
    
    await publish(
      anthropicChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return {
      ...context,
      [config.variableName!]: {
        text,
      },
    }
  } catch (error) {
     await publish(
      anthropicChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
