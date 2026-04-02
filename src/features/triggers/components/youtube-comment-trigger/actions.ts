"use server";

import { getSubscriptionToken, type Realtime } from "@inngest/realtime";
import { youtubeCommentTriggerChannel } from "@/inngest/channels/youtube-comment-trigger";
import { inngest } from "@/inngest/client";
import { auth } from "@/lib/auth";
import prisma from "@/lib/db";
import { headers } from "next/headers";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

export type YoutubeCommentTriggerToken = Realtime.Token<
  typeof youtubeCommentTriggerChannel,
  ["status"]
>;

export async function fetchYoutubeCommentTriggerRealtimeToken(): Promise<YoutubeCommentTriggerToken> {
  const token = await getSubscriptionToken(inngest, {
    channel: youtubeCommentTriggerChannel(),
    topics: ["status"],
  });

  return token;
}

export type YoutubeCommentTriggerConfig = {
  videoId?: string;
  keywordFilter?: string;
};

export async function saveYoutubeCommentTriggerConfig(
  nodeId: string,
  config: YoutubeCommentTriggerConfig,
): Promise<void> {
  const parsed = parseNodeConfig(
    NodeType.YOUTUBE_COMMENT_TRIGGER,
    config,
  ) as YoutubeCommentTriggerConfig;

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
        videoId: parsed.videoId ?? "",
        keywordFilter: parsed.keywordFilter ?? "",
      },
    },
  });
}
