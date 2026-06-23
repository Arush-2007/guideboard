import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { headers } from "next/headers";
import { inngest } from "@/inngest/client";
import { auth } from "@/lib/auth";

/**
 * Mints a realtime subscription token scoped to the CURRENT user's channel.
 *
 * Status channels are parameterized by userId (e.g. `anthropic-execution:<userId>`),
 * so a token only grants access to that user's own node-status stream. This closes
 * the prior leak where channels were global (`channel("anthropic-execution")`) and
 * any subscriber's token received EVERY user's node statuses — isolation had relied
 * only on client-side nodeId filtering.
 *
 * Used by every `fetch*RealtimeToken` server action; pass the channel's factory
 * (e.g. `anthropicChannel`) and this resolves the session user and scopes it.
 */
export async function mintUserStatusToken(
  channelFor: (userId: string) => Realtime.Channel,
): Promise<Realtime.Subscribe.Token> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    throw new Error(
      "Unauthorized: cannot mint a realtime token without a session",
    );
  }

  return getSubscriptionToken(inngest, {
    channel: channelFor(session.user.id),
    topics: ["status"],
  });
}
