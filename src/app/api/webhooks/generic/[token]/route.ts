/**
 * Generic catch-all webhook trigger.
 *
 * Each WEBHOOK_TRIGGER node owns an unguessable `token` (its public URL
 * segment). POSTing to `/api/webhooks/generic/<token>` runs that token's
 * workflow with the request body + headers as `initialData.webhook`.
 *
 * This is a public, unauthenticated endpoint on a paid service, so the order of
 * checks matters: cheap in-memory rate-limit and a payload-size cap run BEFORE
 * the DB lookup, token secrecy is the baseline auth, and an optional
 * `X-Guideboard-Signature` HMAC adds payload integrity when present.
 */

import { type NextRequest, NextResponse } from "next/server";
import { sendWorkflowExecution } from "@/inngest/utils";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { logger } from "@/lib/logger";
import { isAllowed } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/webhook-verify";

// 1 MB cap — generic webhooks carry small JSON payloads; anything larger is
// almost certainly abuse and would bloat the persisted Execution.input.
const MAX_BODY_BYTES = 1_000_000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;

    // Per-token rate limit, before any DB work so a flood can't drive load.
    if (!isAllowed(`webhook:generic:${token}`, 100, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    // Early reject on declared size, then enforce the real size after reading.
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { success: false, error: "Payload too large" },
        { status: 413 },
      );
    }

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json(
        { success: false, error: "Payload too large" },
        { status: 413 },
      );
    }

    const webhook = await prisma.webhookTrigger.findUnique({
      where: { token },
      select: { workflowId: true, secret: true, requireSignature: true },
    });
    if (!webhook) {
      return NextResponse.json(
        { success: false, error: "Unknown webhook" },
        { status: 404 },
      );
    }

    // Per-trigger policy, not a global one. Triggers created from 2026-08-04
    // REQUIRE a signature; rows that predate that keep the opt-in behaviour
    // their caller was built against, until the user turns it on in the dialog.
    // See `WebhookTrigger.requireSignature`.
    //
    // The secret is per-trigger and comes from the database rather than the
    // environment, so the seam's unset branch is unreachable — `secretName`
    // names the column for a message that cannot be produced.
    const auth = verifyWebhookRequest({
      request,
      rawBody,
      scheme: { kind: "hmac-sha256", header: "x-guideboard-signature" },
      secret: decrypt(webhook.secret),
      secretName: "WebhookTrigger.secret",
      ...(webhook.requireSignature
        ? {
            mode: "required" as const,
            invalidMessage:
              "This webhook requires a signed request. Send " +
              "X-Guideboard-Signature as sha256=<HMAC of the raw body> using " +
              "the signing secret.",
          }
        : { mode: "if-present" as const, invalidMessage: "Invalid signature" }),
    });
    if (!auth.ok) return auth.response;

    // Lenient body: parse JSON when possible, otherwise pass the raw string
    // through so non-JSON callers still work.
    let body: unknown = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Default is one run per POST; callers that retry can opt into at-most-once
    // delivery by sending an `Idempotency-Key` header.
    const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;

    await sendWorkflowExecution({
      workflowId: webhook.workflowId,
      initialData: { webhook: { body, headers } },
      idempotencyKey,
    });

    return NextResponse.json({ success: true }, { status: 202 });
  } catch (error) {
    logger.error("Generic webhook error", error);
    return NextResponse.json(
      { success: false, error: "Failed to process webhook" },
      { status: 500 },
    );
  }
}
