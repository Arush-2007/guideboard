import { channel, topic } from "@inngest/realtime";

export const CONDITION_CHANNEL_NAME = "condition-execution";

export const conditionChannel = channel(CONDITION_CHANNEL_NAME).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
