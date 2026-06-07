import "server-only";

import { type NextRequest, NextResponse } from "next/server";
import { NodeType } from "@/generated/prisma";
import { sendWorkflowExecution } from "@/inngest/utils";
import prisma from "@/lib/db";
import { isAllowed } from "@/lib/rate-limit";
import { verifyYoutubeWebhookSignature } from "@/lib/webhook-verify";

type YoutubeCommentTriggerData = {
  videoId?: string;
  keywordFilter?: string;
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const challenge = searchParams.get("hub.challenge");
  const verifyToken = searchParams.get("hub.verify_token");

  const expectedToken = process.env.YOUTUBE_VERIFY_TOKEN;
  if (!expectedToken) {
    return new NextResponse(null, { status: 503 });
  }

  if (verifyToken !== expectedToken) {
    return new NextResponse(null, { status: 403 });
  }

  if (challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new NextResponse(null, { status: 200 });
}

export async function POST(request: NextRequest) {
  try {
    if (!isAllowed("webhook:youtube", 100, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    const webhookSecret = process.env.YOUTUBE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return NextResponse.json(
        {
          success: false,
          error:
            "YOUTUBE_WEBHOOK_SECRET is not configured. Add it to your environment to verify webhooks.",
        },
        { status: 503 },
      );
    }

    const rawBody = await request.text();

    const signatureHeader = request.headers.get("x-hub-signature");
    if (!verifyYoutubeWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
      return NextResponse.json(
        { success: false, error: "Invalid YouTube webhook signature" },
        { status: 401 },
      );
    }

    // Extract videoId from Atom XML feed if present
    // YouTube PubSubHubbub sends: <yt:videoId>VIDEO_ID</yt:videoId>
    const videoIdMatch = rawBody.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const videoId = videoIdMatch?.[1]?.trim();

    const channelIdMatch = rawBody.match(
      /<yt:channelId>([^<]+)<\/yt:channelId>/,
    );
    const channelId = channelIdMatch?.[1]?.trim();

    const triggerNodes = await prisma.node.findMany({
      where: { type: NodeType.YOUTUBE_COMMENT_TRIGGER },
      select: { id: true, workflowId: true, data: true },
    });

    if (triggerNodes.length === 0) {
      return NextResponse.json({ success: true }, { status: 200 });
    }

    for (const node of triggerNodes) {
      const data = (node.data ?? {}) as YoutubeCommentTriggerData;

      // If the node is scoped to a specific video, only fire when the
      // notification's videoId is present AND matches. If we couldn't parse a
      // videoId from the payload, don't fire video-scoped triggers — we can't
      // confirm the event is for their video.
      const configuredVideoId = data.videoId?.trim();
      if (configuredVideoId && configuredVideoId !== videoId) {
        continue;
      }

      await sendWorkflowExecution({
        workflowId: node.workflowId,
        initialData: {
          commentId: "",
          commentText: "",
          commenterName: "",
          videoId: videoId ?? "",
          channelId: channelId ?? "",
        },
      });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("YouTube webhook error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process YouTube event" },
      { status: 500 },
    );
  }
}
