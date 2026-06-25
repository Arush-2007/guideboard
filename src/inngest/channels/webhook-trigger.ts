import { channel, topic } from "@inngest/realtime";

export const WEBHOOK_TRIGGER_CHANNEL_NAME = "webhook-trigger-execution";

export const webhookTriggerChannel = channel(
  (userId: string) => `${WEBHOOK_TRIGGER_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
