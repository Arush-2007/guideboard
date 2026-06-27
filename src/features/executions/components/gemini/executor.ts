import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import { describeProviderError } from "@/features/executions/lib/provider-error";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { geminiChannel } from "@/inngest/channels/gemini";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { renderTemplate } from "@/lib/templating";

type GeminiData = {
  credentialId?: string;
  systemPrompt?: string;
  userPrompt?: string;
};

export const geminiExecutor: NodeExecutor<GeminiData> = async ({
  data,
  nodeId,
  outputKey,
  userId,
  context,
  step,
  publish,
}) => {
  await publish(
    geminiChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  let config: GeminiData;
  try {
    config = parseNodeConfig(NodeType.GEMINI, data) as GeminiData;
  } catch (error) {
    await publish(
      geminiChannel(userId).status({
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
      geminiChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError("Gemini node: Credential not found");
  }

  const google = createGoogleGenerativeAI({
    apiKey: decrypt(credential.value),
  });

  try {
    const { steps } = await step.ai.wrap("gemini-generate-text", generateText, {
      model: google("gemini-2.0-flash"),
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
      geminiChannel(userId).status({
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
      geminiChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw describeProviderError(error, "Gemini");
  }
};
