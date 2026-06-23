import type { NodeExecutor } from "@/features/executions/types";
import { googleFormTriggerChannel } from "@/inngest/channels/google-form-trigger";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import { NonRetriableError } from "inngest";

type GoogleFormTriggerData = Record<string, unknown>;

export const googleFormTriggerExecutor: NodeExecutor<
  GoogleFormTriggerData
> = async ({ nodeId, userId, context, step, publish, data }) => {
  await publish(
    googleFormTriggerChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  try {
    parseNodeConfig(NodeType.GOOGLE_FORM_TRIGGER, data);
  } catch (error) {
    await publish(
      googleFormTriggerChannel(userId).status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const result = await step.run("google-form-trigger", async () => context);

  await publish(
    googleFormTriggerChannel(userId).status({
      nodeId,
      status: "success",
    }),
  );

  return result;
};
