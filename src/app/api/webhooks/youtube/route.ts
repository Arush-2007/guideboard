import "server-only";

import { type NextRequest, NextResponse } from "next/server";
import { NodeType } from "@/generated/prisma";
import { sendWorkflowExecution } from "@/inngest/utils";
import prisma from "@/lib/db";

type YoutubeCommentTriggerData = {
  videoId?: string;
  keywordFilter?: string;
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const challenge = searchParams.get("hub.challenge");

  // PubSubHubbub verification — return the challenge if present
  if (challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Periodic verification pings from YouTube have no challenge — acknowledge them
  return new NextResponse(null, { status: 200 });
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    // Extract videoId from Atom XML feed if present
    // YouTube PubSubHubbub sends: <yt:videoId>VIDEO_ID</yt:videoId>
    const videoIdMatch = rawBody.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const videoId = videoIdMatch?.[1]?.trim();

    // Extract channel ID if present (useful for future filtering)
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

      // Filter by videoId if configured
      if (
        data.videoId &&
        data.videoId.trim() !== "" &&
        videoId &&
        data.videoId.trim() !== videoId
      ) {
        continue;
      }

      // For PubSubHubbub notifications (new video events), there is no comment
      // data yet — we fire the workflow with whatever we know so that
      // downstream polling steps or manual enrichment can handle the details.
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
