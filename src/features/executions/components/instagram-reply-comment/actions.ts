"use server";

import { instagramReplyChannel } from "@/inngest/channels/instagram-reply-comment";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchInstagramReplyRealtimeToken() {
  return mintUserStatusToken(instagramReplyChannel);
}
