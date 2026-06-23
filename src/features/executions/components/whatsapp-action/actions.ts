"use server";

import { whatsappActionChannel } from "@/inngest/channels/whatsapp-action";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export function fetchWhatsappActionRealtimeToken() {
  return mintUserStatusToken(whatsappActionChannel);
}
