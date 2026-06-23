"use server";

import { gmailTriggerChannel } from "@/inngest/channels/gmail-trigger";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchGmailTriggerRealtimeToken() {
  return mintUserStatusToken(gmailTriggerChannel);
}
