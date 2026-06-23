import { channel, topic } from "@inngest/realtime";

export const AI_TEXT_CHANNEL_NAME = "ai-text-execution";

export const aiTextChannel = channel(
  (userId: string) => `${AI_TEXT_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
