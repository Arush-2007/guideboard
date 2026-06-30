"use server";

import { candidateScoringChannel } from "@/inngest/channels/candidate-scoring";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchCandidateScoringRealtimeToken() {
  return mintUserStatusToken(candidateScoringChannel);
}
