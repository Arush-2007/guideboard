"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { telegramTriggerChannel } from "@/inngest/channels/telegram-trigger";
import { inngest } from "@/inngest/client";

export type TelegramTriggerToken = Realtime.Token<
  typeof telegramTriggerChannel,
  ["status"]
>;

export async function fetchTelegramTriggerRealtimeToken(): Promise<TelegramTriggerToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: telegramTriggerChannel(),
    topics: ["status"],
  });

  return token;
}
