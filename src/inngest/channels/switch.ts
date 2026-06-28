import { channel, topic } from "@inngest/realtime";

export const SWITCH_CHANNEL_NAME = "switch-execution";

export const switchChannel = channel(
  (userId: string) => `${SWITCH_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
