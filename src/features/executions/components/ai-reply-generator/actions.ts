"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { aiReplyGeneratorChannel } from "@/inngest/channels/ai-reply-generator";
import { inngest } from "@/inngest/client";

export type AiReplyGeneratorToken = Realtime.Token<
  typeof aiReplyGeneratorChannel,
  ["status"]
>;

export async function fetchAiReplyGeneratorRealtimeToken(): Promise<AiReplyGeneratorToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: aiReplyGeneratorChannel(),
    topics: ["status"],
  });

  return token;
}
