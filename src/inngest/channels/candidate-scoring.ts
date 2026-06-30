import { channel, topic } from "@inngest/realtime";

export const CANDIDATE_SCORING_CHANNEL_NAME = "candidate-scoring-execution";

export const candidateScoringChannel = channel(
  (userId: string) => `${CANDIDATE_SCORING_CHANNEL_NAME}:${userId}`,
).addTopic(
  topic("status").type<{
    nodeId: string;
    status: "loading" | "success" | "error";
  }>(),
);
