"use server";

import { googleSheetsActionChannel } from "@/inngest/channels/google-sheets-action";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchGoogleSheetsActionRealtimeToken() {
  return mintUserStatusToken(googleSheetsActionChannel);
}
