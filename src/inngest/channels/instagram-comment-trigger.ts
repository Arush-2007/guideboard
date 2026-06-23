import { channel, topic } from "@inngest/realtime";

export const INSTAGRAM_COMMENT_TRIGGER_CHANNEL_NAME =
  "instagram-comment-trigger-execution";

export const instagramCommentTriggerChannel = channel(
  (userId: string) => `${INSTAGRAM_COMMENT_TRIGGER_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
