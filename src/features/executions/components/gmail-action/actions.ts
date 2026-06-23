"use server";

import { gmailActionChannel } from "@/inngest/channels/gmail-action";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchGmailActionRealtimeToken() {
  return mintUserStatusToken(gmailActionChannel);
}
