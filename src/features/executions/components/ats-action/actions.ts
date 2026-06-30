"use server";

import { atsActionChannel } from "@/inngest/channels/ats-action";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchAtsActionRealtimeToken() {
  return mintUserStatusToken(atsActionChannel);
}
