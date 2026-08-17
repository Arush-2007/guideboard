/**
 * Google Form webhook endpoint.
 *
 * The caller is an Apps Script bound to the user's form (see
 * `generateGoogleFormScript`). It authenticates with a **per-workflow token** in
 * the URL plus an HMAC-SHA256 signature over the raw body — resolved and
 * verified by `authenticateTokenWebhook`, which every token webhook shares.
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
import { normalizeResponseKeys } from "@/lib/form-responses";
import { logger } from "@/lib/logger";
import { authenticateTokenWebhook } from "@/lib/token-webhook";
import { googleFormIdempotencyKey } from "@/lib/webhook-idempotency";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;

    const auth = await authenticateTokenWebhook({
      request,
      token,
      nodeType: NodeType.GOOGLE_FORM_TRIGGER,
      signatureRequiredMessage:
        "This webhook requires a signed request. Re-copy the Apps Script from " +
        "the Google Form node — the current one signs each submission.",
    });
    if (!auth.ok) return auth.response;

    let parsed: unknown;
    try {
      parsed = JSON.parse(auth.rawBody);
    } catch {
      return NextResponse.json(
        { success: false, error: "Body must be JSON" },
        { status: 400 },
      );
    }

    // Parsed, but not necessarily an OBJECT. `null`, `42` and `"hi"` are all
    // valid JSON, so the catch above does not fire for them — and asserting the
    // parse straight into a shape would turn the first `body.formId` into a
    // TypeError, surfacing as a 500 and an error-level log where the code
    // plainly means 400. An array is rejected for the same reason: it cannot be
    // a form submission, so the only thing it can be is a malformed caller.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return NextResponse.json(
        { success: false, error: "Body must be a JSON object" },
        { status: 400 },
      );
    }

    const body = parsed as {
      formId?: string;
      formTitle?: string;
      responseId?: string;
      timestamp?: string;
      respondentEmail?: string;
      responses?: unknown;
    };

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
      workflowId: auth.workflowId,
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
