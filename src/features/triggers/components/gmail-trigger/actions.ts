"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { gmailTriggerChannel } from "@/inngest/channels/gmail-trigger";
import { inngest } from "@/inngest/client";

export type GmailTriggerToken = Realtime.Token<
  typeof gmailTriggerChannel,
  ["status"]
>;

export async function fetchGmailTriggerRealtimeToken(): Promise<GmailTriggerToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: gmailTriggerChannel(),
    topics: ["status"],
  });

  return token;
}
