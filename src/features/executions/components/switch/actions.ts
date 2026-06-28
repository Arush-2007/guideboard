"use server";

import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";
import { switchChannel } from "@/inngest/channels/switch";

export async function fetchSwitchRealtimeToken() {
  return mintUserStatusToken(switchChannel);
}
