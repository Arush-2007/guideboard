import { channel, topic } from "@inngest/realtime";

export const GOOGLE_SHEETS_ACTION_CHANNEL_NAME = "google-sheets-action-execution";

export const googleSheetsActionChannel = channel(
  GOOGLE_SHEETS_ACTION_CHANNEL_NAME,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
