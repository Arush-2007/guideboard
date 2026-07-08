import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";

type GoogleFormTriggerData = {
  formId?: string;
  formTitle?: string;
  discoveredFields?: { path: string; label: string }[];
};

export const googleFormTriggerExecutor: NodeExecutor<
  GoogleFormTriggerData
> = async ({ nodeId, userId, context, step, publish, data }) => {
  await publish(
    nodeStatusChannel(userId).status({ nodeId, status: "loading" }),
  );

  try {
    parseNodeConfig(NodeType.GOOGLE_FORM_TRIGGER, data);
  } catch (error) {
    await publish(
      nodeStatusChannel(userId).status({ nodeId, status: "error" }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  // Generic trigger: the webhook already seeded `googleForm` (formId, responses,
  // respondentEmail, …) into the context. We pass it straight through so any
  // downstream node can reference the raw responses — no domain-specific shaping.
  const result = await step.run("google-form-trigger", async () => context);

  await publish(
    nodeStatusChannel(userId).status({ nodeId, status: "success" }),
  );

  return result;
};
