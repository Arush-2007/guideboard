/**
 * Google Form webhook endpoint.
 *
 * Callers must authenticate by passing the shared secret via either:
 *   - `x-webhook-secret` request header (preferred), OR
 *   - `?secret=` query parameter
 *
 * The secret must match GOOGLE_FORM_WEBHOOK_SECRET, compared in constant time.
 *
 * **Fails CLOSED when the secret is unset**, matching every other webhook in
 * this directory (Telegram, Typeform, YouTube, Instagram all refuse rather than
 * run unauthenticated). This route used to skip verification entirely in that
 * case, which was survivable only for as long as an unedited `.env` still
 * counted as "set" — the placeholder was a non-empty string, so requests that
 * did not present it were rejected. Once `env()` began collapsing placeholders
 * to `undefined` (correctly — see `lib/env.ts`), that accident stopped holding
 * and the endpoint became fully open: any unauthenticated POST could start a
 * workflow run. An endpoint that starts billable, side-effecting work must
 * never be the one that treats "no credential configured" as "allow".
 */

import { type NextRequest, NextResponse } from "next/server";
import { sendWorkflowExecution } from "@/inngest/utils";
import { normalizeResponseKeys } from "@/lib/form-responses";
import { logger } from "@/lib/logger";
import { isAllowed } from "@/lib/rate-limit";
import { googleFormIdempotencyKey } from "@/lib/webhook-idempotency";
import { verifyWebhookRequest } from "@/lib/webhook-verify";

export async function POST(request: NextRequest) {
  try {
    if (!isAllowed("webhook:google-form", 100, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    const url = new URL(request.url);

    // The query-parameter fallback exists because Apps Script's simplest
    // `UrlFetchApp` call cannot set headers; the header is preferred, since a
    // URL secret reaches proxy logs and browser history that a header does not.
    const auth = verifyWebhookRequest({
      request,
      scheme: {
        kind: "shared-secret",
        header: "x-webhook-secret",
        queryParam: "secret",
      },
      secret: process.env.GOOGLE_FORM_WEBHOOK_SECRET,
      secretName: "GOOGLE_FORM_WEBHOOK_SECRET",
    });
    if (!auth.ok) return auth.response;

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
