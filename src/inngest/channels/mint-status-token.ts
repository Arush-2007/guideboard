import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { headers } from "next/headers";
import { inngest } from "@/inngest/client";
import { auth } from "@/lib/auth";

/**
 * Mints a realtime subscription token scoped to the CURRENT user's channel.
 *
 * The status channel is parameterized by userId (`node-status:<userId>`), so a
 * token only grants access to that user's own node-status stream. This closes the
 * prior leak where channels were global (`channel("node-status")`) and any
 * subscriber's token received EVERY user's node statuses — isolation had relied
 * only on client-side nodeId filtering.
 *
 * Used by `fetchNodeStatusRealtimeToken`; pass the channel's factory
 * (`nodeStatusChannel`) and this resolves the session user and scopes it.
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
