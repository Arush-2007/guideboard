"use server";

import { typeformTriggerChannel } from "@/inngest/channels/typeform-trigger";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchTypeformTriggerRealtimeToken() {
  return mintUserStatusToken(typeformTriggerChannel);
}
