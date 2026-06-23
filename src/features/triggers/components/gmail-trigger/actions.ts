"use server";

import { gmailTriggerChannel } from "@/inngest/channels/gmail-trigger";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchGmailTriggerRealtimeToken() {
  return mintUserStatusToken(gmailTriggerChannel);
}
