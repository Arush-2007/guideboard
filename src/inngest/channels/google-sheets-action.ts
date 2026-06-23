import { channel, topic } from "@inngest/realtime";

export const GOOGLE_SHEETS_ACTION_CHANNEL_NAME =
  "google-sheets-action-execution";

export const googleSheetsActionChannel = channel(
  (userId: string) => `${GOOGLE_SHEETS_ACTION_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
