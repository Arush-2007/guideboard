"use server";

import { notionChannel } from "@/inngest/channels/notion";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchNotionRealtimeToken() {
  return mintUserStatusToken(notionChannel);
}
