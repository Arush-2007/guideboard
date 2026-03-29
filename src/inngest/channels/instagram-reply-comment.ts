import { channel, topic } from "@inngest/realtime";

export const INSTAGRAM_REPLY_COMMENT_CHANNEL_NAME =
  "instagram-reply-comment-execution";

export const instagramReplyChannel = channel(
  INSTAGRAM_REPLY_COMMENT_CHANNEL_NAME,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
