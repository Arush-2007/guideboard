import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { openAiChannel } from "@/inngest/channels/openai";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { renderTemplate } from "@/lib/templating";

type OpenAiData = {
  credentialId?: string;
  systemPrompt?: string;
  userPrompt?: string;
};

export const openAiExecutor: NodeExecutor<OpenAiData> = async ({
  data,
  nodeId,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    openAiChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  let config: OpenAiData;
  try {
    config = parseNodeConfig(NodeType.OPENAI, data) as OpenAiData;
  } catch (error) {
    await publish(
      openAiChannel().status({
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
  const outputKey = `${NodeType.OPENAI.toLowerCase()}_${nodeId}`;

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
      openAiChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("OpenAI node: Credential not found");
  }

  const openai = createOpenAI({
    apiKey: decrypt(credential.value),
  });

  try {
    const { steps } = await step.ai.wrap("openai-generate-text", generateText, {
      model: openai("gpt-4"),
      system: systemPrompt,
      prompt: userPrompt,
      experimental_telemetry: {
        isEnabled: true,
        recordInputs: true,
        recordOutputs: true,
      },
    });

    const text =
      steps[0].content[0].type === "text" ? steps[0].content[0].text : "";

    await publish(
      openAiChannel().status({
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
      openAiChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw error;
  }
};
