import { channel, topic } from "@inngest/realtime";

export const GOOGLE_SHEETS_TRIGGER_CHANNEL_NAME =
  "google-sheets-trigger-execution";

export const googleSheetsTriggerChannel = channel(
  GOOGLE_SHEETS_TRIGGER_CHANNEL_NAME,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
