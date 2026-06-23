import { channel, topic } from "@inngest/realtime";

export const ANTHROPIC_CHANNEL_NAME = "anthropic-execution";

// Parameterized by userId so each user gets an isolated channel
// (`anthropic-execution:<userId>`). Publish with `anthropicChannel(userId)`;
// tokens are minted for the session user via mintUserStatusToken.
export const anthropicChannel = channel(
  (userId: string) => `${ANTHROPIC_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
