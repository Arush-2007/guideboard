import { channel, topic } from "@inngest/realtime";

export const YOUTUBE_REPLY_COMMENT_CHANNEL_NAME =
  "youtube-reply-comment-execution";

export const youtubeReplyChannel = channel(
  YOUTUBE_REPLY_COMMENT_CHANNEL_NAME,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
