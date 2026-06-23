"use server";

import { telegramTriggerChannel } from "@/inngest/channels/telegram-trigger";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchTelegramTriggerRealtimeToken() {
  return mintUserStatusToken(telegramTriggerChannel);
}
