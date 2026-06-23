"use server";

import { instagramCommentTriggerChannel } from "@/inngest/channels/instagram-comment-trigger";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";
import { auth } from "@/lib/auth";
import prisma from "@/lib/db";
import { headers } from "next/headers";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";

export async function fetchInstagramCommentTriggerRealtimeToken() {
  return mintUserStatusToken(instagramCommentTriggerChannel);
}

export type InstagramCommentTriggerConfig = {
  postId?: string;
  keywordFilter?: string;
};

export async function saveInstagramCommentTriggerConfig(
  nodeId: string,
  config: InstagramCommentTriggerConfig,
): Promise<void> {
  const parsed = parseNodeConfig(
    NodeType.INSTAGRAM_COMMENT_TRIGGER,
    config,
  ) as InstagramCommentTriggerConfig;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const node = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });

  const { replyMessage: _omitReplyMessage, ...restData } =
    (node.data as Record<string, unknown>) ?? {};

  await prisma.node.update({
    where: { id: nodeId },
    data: {
      data: {
        ...restData,
        postId: parsed.postId ?? "",
        keywordFilter: parsed.keywordFilter ?? "",
      },
    },
  });
}
