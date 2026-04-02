import type { NodeExecutor } from "@/features/executions/types";
import { stripeTriggerChannel } from "@/inngest/channels/stripe-trigger";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import { NonRetriableError } from "inngest";

type StripeTriggerData = Record<string, unknown>;

export const stripeTriggerExecutor: NodeExecutor<StripeTriggerData> = async ({
  nodeId,
  context,
  step,
  publish,
  data,
}) => {
  await publish(
    stripeTriggerChannel().status({
      nodeId,
      status: "loading",
    }),
  );

  try {
    parseNodeConfig(NodeType.STRIPE_TRIGGER, data);
  } catch (error) {
    await publish(
      stripeTriggerChannel().status({
        nodeId,
        status: "error",
      }),
    );
    throw new NonRetriableError(
      error instanceof Error ? error.message : "Invalid node config",
    );
  }

  const result = await step.run("stripe-trigger", async () => context);

  await publish(
    stripeTriggerChannel().status({
      nodeId,
      status: "success",
    }),
  );

  return result;
};
