"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { googleSheetsActionChannel } from "@/inngest/channels/google-sheets-action";
import { inngest } from "@/inngest/client";

export type GoogleSheetsActionToken = Realtime.Token<
  typeof googleSheetsActionChannel,
  ["status"]
>;

export async function fetchGoogleSheetsActionRealtimeToken(): Promise<GoogleSheetsActionToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: googleSheetsActionChannel(),
    topics: ["status"],
  });

  return token;
}
