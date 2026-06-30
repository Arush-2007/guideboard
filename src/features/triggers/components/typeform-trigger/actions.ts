"use server";

import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";
import { typeformTriggerChannel } from "@/inngest/channels/typeform-trigger";

export async function fetchTypeformTriggerRealtimeToken() {
  return mintUserStatusToken(typeformTriggerChannel);
}
