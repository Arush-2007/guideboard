"use server";

import { telegramActionChannel } from "@/inngest/channels/telegram-action";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchTelegramActionRealtimeToken() {
  return mintUserStatusToken(telegramActionChannel);
}
