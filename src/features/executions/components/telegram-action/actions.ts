"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { telegramActionChannel } from "@/inngest/channels/telegram-action";
import { inngest } from "@/inngest/client";

export type TelegramActionToken = Realtime.Token<
  typeof telegramActionChannel,
  ["status"]
>;

export async function fetchTelegramActionRealtimeToken(): Promise<TelegramActionToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: telegramActionChannel(),
    topics: ["status"],
  });

  return token;
}
