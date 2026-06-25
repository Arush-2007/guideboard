import { channel, topic } from "@inngest/realtime";

export const SCHEDULE_TRIGGER_CHANNEL_NAME = "schedule-trigger-execution";

export const scheduleTriggerChannel = channel(
  (userId: string) => `${SCHEDULE_TRIGGER_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
