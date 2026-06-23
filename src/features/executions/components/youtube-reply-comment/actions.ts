"use server";

import { youtubeReplyChannel } from "@/inngest/channels/youtube-reply-comment";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchYoutubeReplyRealtimeToken() {
  return mintUserStatusToken(youtubeReplyChannel);
}
