"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { youtubeReplyChannel } from "@/inngest/channels/youtube-reply-comment";
import { inngest } from "@/inngest/client";

export type YoutubeReplyToken = Realtime.Token<
  typeof youtubeReplyChannel,
  ["status"]
>;

export async function fetchYoutubeReplyRealtimeToken(): Promise<YoutubeReplyToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: youtubeReplyChannel(),
    topics: ["status"],
  });

  return token;
}
