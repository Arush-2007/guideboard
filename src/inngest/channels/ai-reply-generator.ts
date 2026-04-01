import { channel, topic } from "@inngest/realtime";

export const AI_REPLY_GENERATOR_CHANNEL_NAME = "ai-reply-generator-execution";

export const aiReplyGeneratorChannel = channel(
  AI_REPLY_GENERATOR_CHANNEL_NAME,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
