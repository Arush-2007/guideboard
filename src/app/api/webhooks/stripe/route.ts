import { type NextRequest, NextResponse } from "next/server";
import { sendWorkflowExecution } from "@/inngest/utils";
import { verifyStripeWebhookSignature } from "@/lib/webhook-verify";

export async function POST(request: NextRequest) {
  try {
    const signingSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!signingSecret) {
      return NextResponse.json(
        {
          success: false,
          error:
            "STRIPE_WEBHOOK_SECRET is not configured. Add it to your environment to verify webhooks.",
        },
        { status: 503 },
      );
    }

    const rawBody = await request.text();
    const stripeSignature = request.headers.get("stripe-signature");

    if (
      !verifyStripeWebhookSignature(rawBody, stripeSignature, signingSecret)
    ) {
      return NextResponse.json(
        { success: false, error: "Invalid Stripe signature" },
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

    const stripeData = {
      eventId: body.id,
      eventType: body.type,
      timestamp: body.created,
      livemode: body.livemode,
      raw: (body.data as { object?: unknown } | undefined)?.object,
    };

    await sendWorkflowExecution({
      workflowId,
      initialData: {
        stripe: stripeData,
      },
      idempotencyKey: `stripe:${stripeData.eventId as string}`,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process Stripe event" },
      { status: 500 },
    );
  }
}
