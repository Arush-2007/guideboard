"use server";

import { googleSheetsTriggerChannel } from "@/inngest/channels/google-sheets-trigger";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchGoogleSheetsTriggerRealtimeToken() {
  return mintUserStatusToken(googleSheetsTriggerChannel);
}
