"use server";

import { anthropicChannel } from "@/inngest/channels/anthropic";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchAnthropicRealtimeToken() {
  return mintUserStatusToken(anthropicChannel);
}
