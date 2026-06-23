"use server";

import { aiTextChannel } from "@/inngest/channels/ai-text";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchAiTextRealtimeToken() {
  return mintUserStatusToken(aiTextChannel);
}
