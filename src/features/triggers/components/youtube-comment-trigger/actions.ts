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

function extractWorkflowIdFromReferer(referer: string | null): string | null {
  if (!referer) return null;
  try {
    const pathname = new URL(referer).pathname;
    const m = pathname.match(/^\/workflows\/([^/]+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function saveYoutubeCommentTriggerConfig(
  nodeId: string,
  config: YoutubeCommentTriggerConfig,
): Promise<void> {
  console.log("[saveYoutubeCommentTriggerConfig] nodeId received:", nodeId);

  const parsed = parseNodeConfig(
    NodeType.YOUTUBE_COMMENT_TRIGGER,
    config,
  ) as YoutubeCommentTriggerConfig;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const existing = await prisma.node.findUnique({
    where: { id: nodeId },
    include: { workflow: { select: { userId: true, id: true } } },
  });

  if (existing && existing.workflow.userId !== session.user.id) {
    throw new Error("Forbidden");
  }

  const prev = (existing?.data as Record<string, unknown>) ?? {};
  const mergedData = {
    ...prev,
    videoId: parsed.videoId ?? "",
    keywordFilter: parsed.keywordFilter ?? "",
  };

  let workflowIdForCreate: string;
  if (existing) {
    workflowIdForCreate = existing.workflowId;
  } else {
    const headerList = await headers();
    const fromReferer = extractWorkflowIdFromReferer(headerList.get("referer"));
    if (!fromReferer) {
      throw new Error(
        "Could not resolve workflow for this node. Save the workflow from the editor first, then configure the trigger again.",
      );
    }
    const owned = await prisma.workflow.findFirst({
      where: { id: fromReferer, userId: session.user.id },
      select: { id: true },
    });
    if (!owned) {
      throw new Error("Workflow not found or access denied.");
    }
    workflowIdForCreate = owned.id;
  }

  await prisma.node.upsert({
    where: { id: nodeId },
    create: {
      id: nodeId,
      workflowId: workflowIdForCreate,
      name: "YouTube Comment Trigger",
      type: NodeType.YOUTUBE_COMMENT_TRIGGER,
      position: { x: 0, y: 0 },
      data: mergedData,
    },
    update: {
      data: mergedData,
    },
  });
}
