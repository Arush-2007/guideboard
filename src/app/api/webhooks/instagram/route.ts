import "server-only";

import { type NextRequest, NextResponse } from "next/server";
import { NodeType } from "@/generated/prisma";
import { sendWorkflowExecution } from "@/inngest/utils";
import prisma from "@/lib/db";
import { refreshInstagramTokenIfNeeded } from "@/lib/instagram-token";
import { logger } from "@/lib/logger";
import { isAllowed } from "@/lib/rate-limit";
import { verifyInstagramWebhookSignature } from "@/lib/webhook-verify";

type CommentValue = {
  id: string;
  text: string;
  from: { id: string; username: string };
  media: { id: string };
};

type InstagramEntry = {
  changes: Array<{
    field: string;
    value: CommentValue;
  }>;
};

type InstagramPayload = {
  object: string;
  entry: InstagramEntry[];
};

type InstagramCommentTriggerData = {
  postId?: string;
  keywordFilter?: string;
  replyMessage?: string;
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token === process.env.INSTAGRAM_VERIFY_TOKEN &&
    challenge
  ) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new NextResponse(null, { status: 403 });
}

export async function POST(request: NextRequest) {
  try {
    if (!isAllowed("webhook:instagram", 100, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    if (!appSecret) {
      return NextResponse.json(
        {
          success: false,
          error:
            "INSTAGRAM_APP_SECRET is not configured. Required to verify webhook signatures.",
        },
        { status: 503 },
      );
    }

    const rawBody = await request.text();
    const signature =
      request.headers.get("x-hub-signature-256") ??
      request.headers.get("X-Hub-Signature-256");

    if (!verifyInstagramWebhookSignature(rawBody, signature, appSecret)) {
      return NextResponse.json(
        { success: false, error: "Invalid webhook signature" },
        { status: 403 },
      );
    }

    const body = JSON.parse(rawBody) as InstagramPayload;

    if (body.object !== "instagram") {
      return NextResponse.json({ success: true }, { status: 200 });
    }

    const triggerNodes = await prisma.node.findMany({
      where: { type: NodeType.INSTAGRAM_COMMENT_TRIGGER },
      select: {
        id: true,
        workflowId: true,
        data: true,
        workflow: { select: { userId: true } },
      },
    });

    if (triggerNodes.length === 0) {
      return NextResponse.json({ success: true }, { status: 200 });
    }

    // Refresh Instagram tokens for all users with active trigger nodes (non-fatal)
    const uniqueUserIds = [
      ...new Set(triggerNodes.map((n) => n.workflow.userId)),
    ];
    await Promise.all(
      uniqueUserIds.map((userId) =>
        refreshInstagramTokenIfNeeded(userId).catch(() => {
          logger.warn("Instagram token refresh attempt failed");
        }),
      ),
    );

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "comments") continue;

        const value = change.value;
        const commentId = value?.id;
        const commentText = value?.text ?? "";
        const commenterName = value?.from?.username ?? "";
        const postId = value?.media?.id ?? "";

        if (!commentId) continue;

        for (const node of triggerNodes) {
          const data = (node.data ?? {}) as InstagramCommentTriggerData;

          if (
            data.postId &&
            data.postId.trim() !== "" &&
            data.postId.trim() !== postId
          ) {
            continue;
          }

          if (data.keywordFilter && data.keywordFilter.trim() !== "") {
            const keywords = data.keywordFilter
              .split(",")
              .map((k) => k.trim().toLowerCase())
              .filter(Boolean);

            const lowerText = commentText.toLowerCase();
            const hasMatch = keywords.some((kw) => lowerText.includes(kw));
            if (!hasMatch) continue;
          }

          await sendWorkflowExecution({
            workflowId: node.workflowId,
            initialData: {
              commentId,
              commentText,
              commenterName,
              postId,
            },
            idempotencyKey: `instagram:${commentId}`,
          });
        }
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error("Instagram webhook error", error);
    return NextResponse.json(
      { success: false, error: "Failed to process Instagram event" },
      { status: 500 },
    );
  }
}
