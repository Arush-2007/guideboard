"use server";

import { slackChannel } from "@/inngest/channels/slack";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchSlackRealtimeToken() {
  return mintUserStatusToken(slackChannel);
}
