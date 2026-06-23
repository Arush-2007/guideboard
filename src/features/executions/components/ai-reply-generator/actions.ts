"use server";

import { aiReplyGeneratorChannel } from "@/inngest/channels/ai-reply-generator";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchAiReplyGeneratorRealtimeToken() {
  return mintUserStatusToken(aiReplyGeneratorChannel);
}
