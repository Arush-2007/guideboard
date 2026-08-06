/**
 * Google Form webhook endpoint.
 *
 * The caller is an Apps Script bound to the user's form (see
 * `generateGoogleFormScript`). It authenticates with a **per-workflow token** in
 * the URL plus an HMAC-SHA256 signature over the raw body — the same pair the
 * generic webhook uses, read from the same `WebhookTrigger` table.
 *
 * ## Why this replaced `?workflowId=<id>` + a global shared secret
 *
 * The old endpoint authenticated with one process-wide
 * `GOOGLE_FORM_WEBHOOK_SECRET` and took its target workflow from a query
 * parameter. Two things were wrong with that, and the second one broke every
 * Google Form trigger in production:
 *
 *  1. One secret authorised a POST to ANY `workflowId`, and the route never
 *     checked who owned that workflow. Anyone holding it could run anyone's
 *     workflow. Handing it to users — which is what making the trigger work at
 *     all would have required — would have made it a master key.
 *
 *  2. **Nothing ever sent it.** The generated Apps Script set no headers and no
 *     `?secret=`, so the credential the route demanded did not exist on the
 *     wire. That went unnoticed only because the route ALSO treated an unset
 *     secret as "allow"; when that fail-open was closed, every submission
 *     started returning 503 and no workflow ran. The script swallowed the
 *     failure, so it surfaced as silence rather than an error.
 *
 * A per-workflow token fixes both: it names the target (no `workflowId`
 * parameter to forge) and it is scoped to one workflow, so leaking one exposes
 * one integration and can be rotated alone.
 */

import { type NextRequest, NextResponse } from "next/server";
import { NodeType } from "@/generated/prisma";
import { sendWorkflowExecution } from "@/inngest/utils";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { normalizeResponseKeys } from "@/lib/form-responses";
import { logger } from "@/lib/logger";
import { isAllowed } from "@/lib/rate-limit";
import { googleFormIdempotencyKey } from "@/lib/webhook-idempotency";
import { verifyWebhookRequest } from "@/lib/webhook-verify";

// 1 MB cap, matching the generic webhook. A form response is small; anything
// larger is abuse and would bloat the persisted Execution.input.
const MAX_BODY_BYTES = 1_000_000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;

    // Per-token rate limit, before any DB work so a flood can't drive load.
    if (!isAllowed(`webhook:google-form:${token}`, 100, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { success: false, error: "Payload too large" },
        { status: 413 },
      );
    }

    // Read the body as TEXT: the signature covers the exact bytes sent, and a
    // re-serialized object would not reproduce them.
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json(
        { success: false, error: "Payload too large" },
        { status: 413 },
      );
    }

    const trigger = await prisma.webhookTrigger.findUnique({
      where: { token },
      select: {
        workflowId: true,
        secret: true,
        requireSignature: true,
        nodeType: true,
      },
    });
    // Tokens are globally unique across trigger types, so a generic webhook's
    // token must not authenticate here — it would run a workflow whose trigger
    // shapes context differently. 404 for both cases keeps a wrong-endpoint
    // token indistinguishable from an unknown one.
    if (!trigger || trigger.nodeType !== NodeType.GOOGLE_FORM_TRIGGER) {
      return NextResponse.json(
        { success: false, error: "Unknown webhook" },
        { status: 404 },
      );
    }

    // The secret is per-trigger and comes from the database, not the
    // environment, so the seam's unset branch is unreachable — `secretName`
    // names the column for a message that cannot be produced.
    //
    // `requireSignature` is per-row: everything provisioned from here on is
    // created with it true, so a form connected with the current script is
    // always signed. The `if-present` branch exists for rows carrying the
    // column default, and verifies a signature whenever one is offered.
    const auth = verifyWebhookRequest({
      request,
      rawBody,
      scheme: { kind: "hmac-sha256", header: "x-guideboard-signature" },
      secret: decrypt(trigger.secret),
      secretName: "WebhookTrigger.secret",
      ...(trigger.requireSignature
        ? {
            mode: "required" as const,
            invalidMessage:
              "This webhook requires a signed request. Re-copy the Apps " +
              "Script from the Google Form node — the current one signs each " +
              "submission.",
          }
        : { mode: "if-present" as const, invalidMessage: "Invalid signature" }),
    });
    if (!auth.ok) return auth.response;

    let body: {
      formId?: string;
      formTitle?: string;
      responseId?: string;
      timestamp?: string;
      respondentEmail?: string;
      responses?: unknown;
    };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { success: false, error: "Body must be JSON" },
        { status: 400 },
      );
    }

    const formData = {
      formId: body.formId,
      formTitle: body.formTitle,
      responseId: body.responseId,
      timestamp: body.timestamp,
      respondentEmail: body.respondentEmail,
      // Keys are trimmed to match the picker's paths, which are built from the
      // question title trimmed — the Apps Script keys them raw, so a title with
      // a stray space produced an unreachable key. `raw` keeps the original.
      responses: normalizeResponseKeys(body.responses),
      raw: body,
    };

    await sendWorkflowExecution({
      workflowId: trigger.workflowId,
      initialData: {
        googleForm: formData,
      },
      idempotencyKey: googleFormIdempotencyKey(body.responseId),
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error("Google form webhook error", error);
    return NextResponse.json(
      { success: false, error: "Failed to process Google Form submission" },
      { status: 500 },
    );
  }
}
