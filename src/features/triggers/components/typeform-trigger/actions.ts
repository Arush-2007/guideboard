"use server";

import { typeformTriggerChannel } from "@/inngest/channels/typeform-trigger";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchTypeformTriggerRealtimeToken() {
  return mintUserStatusToken(typeformTriggerChannel);
}
