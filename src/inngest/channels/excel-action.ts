import { channel, topic } from "@inngest/realtime";

export const EXCEL_ACTION_CHANNEL_NAME = "excel-action-execution";

export const excelActionChannel = channel(
  (userId: string) => `${EXCEL_ACTION_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
