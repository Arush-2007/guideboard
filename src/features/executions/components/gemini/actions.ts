"use server";

import { geminiChannel } from "@/inngest/channels/gemini";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchGeminiRealtimeToken() {
  return mintUserStatusToken(geminiChannel);
}
