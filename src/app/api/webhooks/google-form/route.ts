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

import { sendWorkflowExecution } from "@/inngest/utils";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url);

    const providedSecret =
      request.headers.get("x-webhook-secret") ??
      url.searchParams.get("secret");
    const expectedSecret = process.env.GOOGLE_FORM_WEBHOOK_SECRET;

    if (expectedSecret) {
      if (providedSecret !== expectedSecret) {
        return new Response("Unauthorized", { status: 401 });
      }
    } else {
      console.warn(
        "GOOGLE_FORM_WEBHOOK_SECRET is not set — Google Form webhook is unauthenticated",
      );
    }

    const workflowId = url.searchParams.get("workflowId");

    if (!workflowId) {
      return NextResponse.json(
        { success: false, error: "Missing required query parameter: workflowId" },
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
      responses: body.responses,
      raw: body,
    };

    await sendWorkflowExecution({
      workflowId,
      initialData: {
        googleForm: formData,
      },
      idempotencyKey: `google-form:${workflowId}:${Date.now()}`,
    });

    return NextResponse.json(
      { success: true },
      { status: 200 },
    );
  } catch (error) {
    console.error("Google form webhook error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process Google Form submission" },
      { status: 500 },
    );
  }
}
