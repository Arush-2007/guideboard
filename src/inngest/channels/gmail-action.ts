import { channel, topic } from "@inngest/realtime";

export const GMAIL_ACTION_CHANNEL_NAME = "gmail-action-execution";

export const gmailActionChannel = channel(
  (userId: string) => `${GMAIL_ACTION_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
