import { channel, topic } from "@inngest/realtime";

export const YOUTUBE_COMMENT_TRIGGER_CHANNEL_NAME =
  "youtube-comment-trigger-execution";

export const youtubeCommentTriggerChannel = channel(
  (userId: string) => `${YOUTUBE_COMMENT_TRIGGER_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
