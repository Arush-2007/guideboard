import { channel, topic } from "@inngest/realtime";

export const CONVERT_CHANNEL_NAME = "convert-execution";

export const convertChannel = channel(
  (userId: string) => `${CONVERT_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
