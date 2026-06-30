import { channel, topic } from "@inngest/realtime";

export const ATS_ACTION_CHANNEL_NAME = "ats-action-execution";

export const atsActionChannel = channel(
  (userId: string) => `${ATS_ACTION_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
