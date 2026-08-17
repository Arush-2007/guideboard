/**
 * Generic catch-all webhook trigger.
 *
 * Each WEBHOOK_TRIGGER node owns an unguessable `token` (its public URL
 * segment). POSTing to `/api/webhooks/generic/<token>` runs that token's
 * workflow with the request body + headers as `initialData.webhook`.
 *
 * This is a public endpoint on a paid service, so the order of checks matters —
 * cheap in-memory guards before the DB lookup, token secrecy as the baseline
 * auth, and an `X-Guideboard-Signature` HMAC for payload integrity. All of that
 * lives in `authenticateTokenWebhook`, shared with every other token webhook, so
 * this file holds only what is specific to the generic contract.
 */

import { type NextRequest, NextResponse } from "next/server";
import { NodeType } from "@/generated/prisma";
import { sendWorkflowExecution } from "@/inngest/utils";
import { logger } from "@/lib/logger";
import { authenticateTokenWebhook } from "@/lib/token-webhook";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;

    const auth = await authenticateTokenWebhook({
      request,
      token,
      nodeType: NodeType.WEBHOOK_TRIGGER,
      signatureRequiredMessage:
        "This webhook requires a signed request. Send X-Guideboard-Signature " +
        "as sha256=<HMAC of the raw body> using the signing secret.",
    });
    if (!auth.ok) return auth.response;

    // Lenient body: parse JSON when possible, otherwise pass the raw string
    // through so non-JSON callers still work.
    let body: unknown = {};
    if (auth.rawBody.length > 0) {
      try {
        body = JSON.parse(auth.rawBody);
      } catch {
        body = auth.rawBody;
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
      workflowId: auth.workflowId,
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
