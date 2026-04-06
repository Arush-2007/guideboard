"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { typeformTriggerChannel } from "@/inngest/channels/typeform-trigger";
import { inngest } from "@/inngest/client";

export type TypeformTriggerToken = Realtime.Token<
  typeof typeformTriggerChannel,
  ["status"]
>;

export async function fetchTypeformTriggerRealtimeToken(): Promise<TypeformTriggerToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: typeformTriggerChannel(),
    topics: ["status"],
  });

  return token;
}
