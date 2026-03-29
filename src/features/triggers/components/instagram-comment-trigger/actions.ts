"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { instagramCommentTriggerChannel } from "@/inngest/channels/instagram-comment-trigger";
import { inngest } from "@/inngest/client";
import { auth } from "@/lib/auth";
import prisma from "@/lib/db";
import { headers } from "next/headers";

export type InstagramCommentTriggerToken = Realtime.Token<
  typeof instagramCommentTriggerChannel,
  ["status"]
>;

export async function fetchInstagramCommentTriggerRealtimeToken(): Promise<InstagramCommentTriggerToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: instagramCommentTriggerChannel(),
    topics: ["status"],
  });

  return token;
}

export type InstagramCommentTriggerConfig = {
  postId?: string;
  keywordFilter?: string;
  replyMessage: string;
};

export async function saveInstagramCommentTriggerConfig(
  nodeId: string,
  config: InstagramCommentTriggerConfig,
): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const node = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });

  await prisma.node.update({
    where: { id: nodeId },
    data: {
      data: {
        ...(node.data as Record<string, unknown>),
        postId: config.postId ?? "",
        keywordFilter: config.keywordFilter ?? "",
        replyMessage: config.replyMessage,
      },
    },
  });
}
