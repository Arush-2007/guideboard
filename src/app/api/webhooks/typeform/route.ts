/**
 * Typeform webhook endpoint.
 *
 * Typeform signs payloads with HMAC-SHA256; the `typeform-signature` header
 * is `sha256=<hex>`. The secret must match TYPEFORM_WEBHOOK_SECRET.
 */

import { sendWorkflowExecution } from "@/inngest/utils";
import { isAllowed } from "@/lib/rate-limit";
import { verifyTypeformWebhookSignature } from "@/lib/webhook-verify";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    if (!isAllowed("webhook:typeform", 100, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    const signingSecret = process.env.TYPEFORM_WEBHOOK_SECRET;
    if (!signingSecret) {
      return NextResponse.json(
        {
          success: false,
          error:
            "TYPEFORM_WEBHOOK_SECRET is not configured. Add it to your environment to verify webhooks.",
        },
        { status: 503 },
      );
    }

    const rawBody = await request.text();
    const typeformSignature = request.headers.get("typeform-signature");

    if (
      !verifyTypeformWebhookSignature(rawBody, typeformSignature, signingSecret)
    ) {
      return NextResponse.json(
        { success: false, error: "Invalid Typeform signature" },
        { status: 400 },
      );
    }

    const url = new URL(request.url);
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

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const formResponse = body.form_response as
      | {
          form_id?: string;
          token?: string;
          submitted_at?: string;
          answers?: unknown[];
        }
      | undefined;

    const token = formResponse?.token;
    if (!token || typeof token !== "string") {
      return NextResponse.json(
        {
          success: false,
          error: "Missing form_response.token in payload",
        },
        { status: 400 },
      );
    }

    const formId =
      typeof formResponse?.form_id === "string" ? formResponse.form_id : "";
    const submittedAt =
      typeof formResponse?.submitted_at === "string"
        ? formResponse.submitted_at
        : "";
    const answers = JSON.stringify(formResponse?.answers ?? []);

    const typeformData = {
      formId,
      submittedAt,
      answers,
      raw: body,
    };

    await sendWorkflowExecution({
      workflowId,
      initialData: {
        typeform: typeformData,
      },
      idempotencyKey: token,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Typeform webhook error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process Typeform submission" },
      { status: 500 },
    );
  }
}
