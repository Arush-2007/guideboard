"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { instagramReplyChannel } from "@/inngest/channels/instagram-reply-comment";
import { inngest } from "@/inngest/client";

export type InstagramReplyToken = Realtime.Token<
  typeof instagramReplyChannel,
  ["status"]
>;

export async function fetchInstagramReplyRealtimeToken(): Promise<InstagramReplyToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: instagramReplyChannel(),
    topics: ["status"],
  });

  return token;
}
