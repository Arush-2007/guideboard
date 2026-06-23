"use server";

import { httpRequestChannel } from "@/inngest/channels/http-request";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchHttpRequestRealtimeToken() {
  return mintUserStatusToken(httpRequestChannel);
}
