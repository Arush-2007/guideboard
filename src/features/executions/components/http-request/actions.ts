"use server";

import { httpRequestChannel } from "@/inngest/channels/http-request";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchHttpRequestRealtimeToken() {
  return mintUserStatusToken(httpRequestChannel);
}
