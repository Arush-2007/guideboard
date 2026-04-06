import { channel, topic } from "@inngest/realtime";

export const TYPEFORM_TRIGGER_CHANNEL_NAME = "typeform-trigger-execution";

export const typeformTriggerChannel = channel(TYPEFORM_TRIGGER_CHANNEL_NAME)
  .addTopic(
    topic("status").type<{
      nodeId: string;
      status: "loading" | "success" | "error";
    }>(),
  );
