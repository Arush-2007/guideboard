import { channel, topic } from "@inngest/realtime";

export const WHATSAPP_ACTION_CHANNEL_NAME = "whatsapp-action-execution";

export const whatsappActionChannel = channel(WHATSAPP_ACTION_CHANNEL_NAME)
  .addTopic(
    topic("status").type<{
      nodeId: string;
      status: "loading" | "success" | "error";
    }>(),
  );
