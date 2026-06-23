import { channel, topic } from "@inngest/realtime";

export const WHATSAPP_ACTION_CHANNEL_NAME = "whatsapp-action-execution";

export const whatsappActionChannel = channel(
  (userId: string) => `${WHATSAPP_ACTION_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
