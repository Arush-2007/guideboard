import { channel, topic } from "@inngest/realtime";

export const NOTION_CHANNEL_NAME = "notion-execution";

export const notionChannel = channel(
  (userId: string) => `${NOTION_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
