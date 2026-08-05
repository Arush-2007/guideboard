/**
 * Typeform webhook endpoint.
 *
 * Typeform signs payloads with HMAC-SHA256; the `typeform-signature` header
 * is `sha256=<hex>`. The secret must match TYPEFORM_WEBHOOK_SECRET.
 */

import { type NextRequest, NextResponse } from "next/server";
import { sendWorkflowExecution } from "@/inngest/utils";
import { logger } from "@/lib/logger";
import { isAllowed } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/webhook-verify";

type TypeformAnswer = {
  type?: string;
  field?: { id?: string; ref?: string };
  [key: string]: unknown;
};

/** Pulls the scalar value out of a Typeform answer based on its `type`. */
function answerValue(answer: TypeformAnswer): string {
  switch (answer.type) {
    case "choice":
      return String((answer.choice as { label?: string })?.label ?? "");
    case "choices":
      return ((answer.choices as { labels?: string[] })?.labels ?? []).join(
        ", ",
      );
    default: {
      // text / email / phone_number / number / boolean / url / date / file_url —
      // each stored under a key matching the answer `type`.
      const value = answer[answer.type ?? ""];
      return value == null ? "" : String(value);
    }
  }
}

/** Builds a `{ ref|id: value }` map from a Typeform answers array. */
function extractTypeformFields(answers: unknown[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const raw of answers) {
    const answer = raw as TypeformAnswer;
    const value = answerValue(answer);
    const ref = answer.field?.ref;
    const id = answer.field?.id;
    if (ref) fields[ref] = value;
    if (id) fields[id] = value;
  }
  return fields;
}

export async function POST(request: NextRequest) {
  try {
    if (!isAllowed("webhook:typeform", 100, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    const rawBody = await request.text();

    const auth = verifyWebhookRequest({
      request,
      rawBody,
      scheme: { kind: "hmac-sha256", header: "typeform-signature" },
      secret: process.env.TYPEFORM_WEBHOOK_SECRET,
      secretName: "TYPEFORM_WEBHOOK_SECRET",
      // 400, not the default 401: this is the code Typeform has always seen
      // from us, and a refactor is the wrong moment to change what a provider
      // observes on failure.
      invalidStatus: 400,
      invalidMessage: "Invalid Typeform signature",
    });
    if (!auth.ok) return auth.response;

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

    // Project answers into an addressable `fields` map keyed by the question's
    // author-set `ref` (and `id` as a fallback), so a trigger's applicant
    // mapping can reference a specific question (e.g. the resume `file_url`).
    const fields = extractTypeformFields(formResponse?.answers ?? []);

    const typeformData = {
      formId,
      submittedAt,
      answers,
      fields,
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
    logger.error("Typeform webhook error", error);
    return NextResponse.json(
      { success: false, error: "Failed to process Typeform submission" },
      { status: 500 },
    );
  }
}
