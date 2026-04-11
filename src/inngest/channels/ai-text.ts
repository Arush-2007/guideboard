import { channel, topic } from "@inngest/realtime";

export const AI_TEXT_CHANNEL_NAME = "ai-text-execution";

export const aiTextChannel = channel(AI_TEXT_CHANNEL_NAME).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
