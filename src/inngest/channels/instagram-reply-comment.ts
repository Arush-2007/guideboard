import { channel, topic } from "@inngest/realtime";

export const INSTAGRAM_REPLY_COMMENT_CHANNEL_NAME =
  "instagram-reply-comment-execution";

export const instagramReplyChannel = channel(
  (userId: string) => `${INSTAGRAM_REPLY_COMMENT_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
