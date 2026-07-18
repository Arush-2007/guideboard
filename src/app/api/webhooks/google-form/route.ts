/**
 * Google Form webhook endpoint.
 *
 * Callers must authenticate by passing the shared secret via either:
 *   - `x-webhook-secret` request header, OR
 *   - `?secret=` query parameter
 *
 * The secret must match the GOOGLE_FORM_WEBHOOK_SECRET environment variable.
 * If the env var is not set the endpoint remains open (for local dev).
 */

import { type NextRequest, NextResponse } from "next/server";
import { sendWorkflowExecution } from "@/inngest/utils";
import { normalizeResponseKeys } from "@/lib/form-responses";
import { logger } from "@/lib/logger";
import { isAllowed } from "@/lib/rate-limit";
import { googleFormIdempotencyKey } from "@/lib/webhook-idempotency";
import { timingSafeStringEqual } from "@/lib/webhook-verify";

export async function POST(request: NextRequest) {
  try {
    if (!isAllowed("webhook:google-form", 100, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    const url = new URL(request.url);

    const providedSecret =
      request.headers.get("x-webhook-secret") ?? url.searchParams.get("secret");
    const expectedSecret = process.env.GOOGLE_FORM_WEBHOOK_SECRET;

    if (expectedSecret) {
      if (!timingSafeStringEqual(providedSecret, expectedSecret)) {
        return NextResponse.json(
          { success: false, error: "Unauthorized" },
          { status: 401 },
        );
      }
    } else {
      logger.warn(
        "GOOGLE_FORM_WEBHOOK_SECRET is not set — Google Form webhook is unauthenticated",
      );
    }

    const workflowId = url.searchParams.get("workflowId");

    if (!workflowId) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required query parameter: workflowId",
        },
        { status: 400 },
      );
    }

    const body = await request.json();

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
      workflowId,
      initialData: {
        googleForm: formData,
      },
      idempotencyKey: googleFormIdempotencyKey(workflowId, body.responseId),
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
