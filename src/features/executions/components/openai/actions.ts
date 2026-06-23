"use server";

import { openAiChannel } from "@/inngest/channels/openai";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchOpenAiRealtimeToken() {
  return mintUserStatusToken(openAiChannel);
}
