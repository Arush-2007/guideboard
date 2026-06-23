"use server";

import { manualTriggerChannel } from "@/inngest/channels/manual-trigger";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchManualTriggerRealtimeToken() {
  return mintUserStatusToken(manualTriggerChannel);
}
