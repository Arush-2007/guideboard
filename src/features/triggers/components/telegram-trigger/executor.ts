import type { NodeExecutor } from "@/features/executions/types";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import { NonRetriableError } from "inngest";

type TelegramTriggerData = Record<string, unknown>;

export const telegramTriggerExecutor: NodeExecutor<
  TelegramTriggerData
> = async ({ nodeId, userId, context, step, publish, data }) => {
  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  try {
    parseNodeConfig(NodeType.TELEGRAM_TRIGGER, data);
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

  const result = await step.run("telegram-trigger", async () => context);

  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "success",
    }),
  );

  return result;
};
