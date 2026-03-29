import { channel, topic } from "@inngest/realtime";

export const INSTAGRAM_COMMENT_TRIGGER_CHANNEL_NAME =
  "instagram-comment-trigger-execution";

export const instagramCommentTriggerChannel = channel(
  INSTAGRAM_COMMENT_TRIGGER_CHANNEL_NAME,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
