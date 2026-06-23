import { channel, topic } from "@inngest/realtime";

export const TELEGRAM_ACTION_CHANNEL_NAME = "telegram-action-execution";

export const telegramActionChannel = channel(
  (userId: string) => `${TELEGRAM_ACTION_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
