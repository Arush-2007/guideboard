"use server";

import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";
import { webhookTriggerChannel } from "@/inngest/channels/webhook-trigger";

export async function fetchWebhookTriggerRealtimeToken() {
  return mintUserStatusToken(webhookTriggerChannel);
}
