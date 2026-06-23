import { channel, topic } from "@inngest/realtime";

export const CONDITION_CHANNEL_NAME = "condition-execution";

export const conditionChannel = channel(
  (userId: string) => `${CONDITION_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
