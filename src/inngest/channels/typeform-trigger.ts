import { channel, topic } from "@inngest/realtime";

export const TYPEFORM_TRIGGER_CHANNEL_NAME = "typeform-trigger-execution";

export const typeformTriggerChannel = channel(
  (userId: string) => `${TYPEFORM_TRIGGER_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
