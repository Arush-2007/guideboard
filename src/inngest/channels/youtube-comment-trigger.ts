import { channel, topic } from "@inngest/realtime";

export const YOUTUBE_COMMENT_TRIGGER_CHANNEL_NAME =
  "youtube-comment-trigger-execution";

export const youtubeCommentTriggerChannel = channel(
  YOUTUBE_COMMENT_TRIGGER_CHANNEL_NAME,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
