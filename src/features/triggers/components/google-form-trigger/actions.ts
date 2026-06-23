"use server";

import { googleFormTriggerChannel } from "@/inngest/channels/google-form-trigger";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchGoogleFormTriggerRealtimeToken() {
  return mintUserStatusToken(googleFormTriggerChannel);
}
