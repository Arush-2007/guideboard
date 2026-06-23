"use server";

import { conditionChannel } from "@/inngest/channels/condition";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchConditionRealtimeToken() {
  return mintUserStatusToken(conditionChannel);
}
