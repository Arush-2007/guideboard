import { NonRetriableError } from "inngest";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { NodeType } from "@/generated/prisma";
import { nodeStatusChannel } from "@/inngest/channels/node-status";

type WebhookTriggerData = Record<string, unknown>;

/**
 * Passthrough trigger: the public route (`/api/webhooks/generic/[token]`) seeds
 * `{ webhook: { body, headers } }` into `initialData`, so this executor only
 * validates config and threads context through — mirroring the other inbound
 * triggers (Telegram, Typeform, Gmail).
 */
export const webhookTriggerExecutor: NodeExecutor<WebhookTriggerData> = async ({
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
    parseNodeConfig(NodeType.WEBHOOK_TRIGGER, data);
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

  const result = await step.run("webhook-trigger", async () => context);

  await publish(
    nodeStatusChannel(userId).status({
      nodeId,
      status: "success",
    }),
  );

  return result;
};
