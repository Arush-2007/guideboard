"use server";

import { notionChannel } from "@/inngest/channels/notion";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchNotionRealtimeToken() {
  return mintUserStatusToken(notionChannel);
}
