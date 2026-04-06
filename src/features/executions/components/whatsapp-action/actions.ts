"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { whatsappActionChannel } from "@/inngest/channels/whatsapp-action";
import { inngest } from "@/inngest/client";

export type WhatsappActionToken = Realtime.Token<
  typeof whatsappActionChannel,
  ["status"]
>;

export async function fetchWhatsappActionRealtimeToken(): Promise<WhatsappActionToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: whatsappActionChannel(),
    topics: ["status"],
  });

  return token;
}
