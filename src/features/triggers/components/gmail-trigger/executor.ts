import type { NodeExecutor } from "@/features/executions/types";
import { nodeStatusChannel } from "@/inngest/channels/node-status";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import { NonRetriableError } from "inngest";

type GmailTriggerData = Record<string, unknown>;

export const gmailTriggerExecutor: NodeExecutor<GmailTriggerData> = async ({
  nodeId,
  userId,
  context,
  step,
  publish,
  data,
}) => {
  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "loading",
    }),
  );

  try {
    parseNodeConfig(NodeType.GMAIL_TRIGGER, data);
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

  const result = await step.run("gmail-trigger", async () => context);

  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "success",
    }),
  );

  return result;
};
