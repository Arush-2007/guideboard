"use server";

import { convertChannel } from "@/inngest/channels/convert";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchConvertRealtimeToken() {
  return mintUserStatusToken(convertChannel);
}
