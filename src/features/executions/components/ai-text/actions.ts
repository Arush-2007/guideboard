"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { aiTextChannel } from "@/inngest/channels/ai-text";
import { inngest } from "@/inngest/client";

export type AiTextToken = Realtime.Token<typeof aiTextChannel, ["status"]>;

export async function fetchAiTextRealtimeToken(): Promise<AiTextToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: aiTextChannel(),
    topics: ["status"],
  });

  return token;
}
