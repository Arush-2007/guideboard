import { channel, topic } from "@inngest/realtime";

export const GMAIL_TRIGGER_CHANNEL_NAME = "gmail-trigger-execution";

export const gmailTriggerChannel = channel(
  (userId: string) => `${GMAIL_TRIGGER_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
