import { channel, topic } from "@inngest/realtime";

export const TELEGRAM_ACTION_CHANNEL_NAME = "telegram-action-execution";

export const telegramActionChannel = channel(TELEGRAM_ACTION_CHANNEL_NAME)
  .addTopic(
    topic("status").type<{
      nodeId: string;
      status: "loading" | "success" | "error";
    }>(),
  );
