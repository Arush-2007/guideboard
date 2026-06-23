import { channel, topic } from "@inngest/realtime";

export const GOOGLE_SHEETS_TRIGGER_CHANNEL_NAME =
  "google-sheets-trigger-execution";

export const googleSheetsTriggerChannel = channel(
  (userId: string) => `${GOOGLE_SHEETS_TRIGGER_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
