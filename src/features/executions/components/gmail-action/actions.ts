"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { gmailActionChannel } from "@/inngest/channels/gmail-action";
import { inngest } from "@/inngest/client";

export type GmailActionToken = Realtime.Token<
  typeof gmailActionChannel,
  ["status"]
>;

export async function fetchGmailActionRealtimeToken(): Promise<GmailActionToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: gmailActionChannel(),
    topics: ["status"],
  });

  return token;
}
