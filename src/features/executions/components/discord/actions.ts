"use server";

import { discordChannel } from "@/inngest/channels/discord";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchDiscordRealtimeToken() {
  return mintUserStatusToken(discordChannel);
}
