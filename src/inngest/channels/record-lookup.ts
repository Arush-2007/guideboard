import { channel, topic } from "@inngest/realtime";

export const RECORD_LOOKUP_CHANNEL_NAME = "record-lookup-execution";

export const recordLookupChannel = channel(
  (userId: string) => `${RECORD_LOOKUP_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
