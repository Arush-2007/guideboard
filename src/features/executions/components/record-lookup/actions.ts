"use server";

import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";
import { recordLookupChannel } from "@/inngest/channels/record-lookup";

export async function fetchRecordLookupRealtimeToken() {
  return mintUserStatusToken(recordLookupChannel);
}
