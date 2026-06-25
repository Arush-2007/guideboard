"use server";

import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";
import { scheduleTriggerChannel } from "@/inngest/channels/schedule-trigger";

export async function fetchScheduleTriggerRealtimeToken() {
  return mintUserStatusToken(scheduleTriggerChannel);
}
