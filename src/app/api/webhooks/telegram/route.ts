/**
 * Telegram Bot API webhook. Validates `X-Telegram-Bot-Api-Secret-Token` against
 * TELEGRAM_WEBHOOK_SECRET (same value as setWebhook `secret_token`).
 */

import { sendWorkflowExecution } from "@/inngest/utils";
import { isAllowed } from "@/lib/rate-limit";
import { verifyTelegramWebhookSecretToken } from "@/lib/webhook-verify";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    if (!isAllowed("webhook:telegram", 200, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expectedSecret) {
      return NextResponse.json(
        {
          success: false,
          error:
            "TELEGRAM_WEBHOOK_SECRET is not configured. Add it to your environment to verify webhooks.",
        },
        { status: 503 },
      );
    }

    const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
    if (!verifyTelegramWebhookSecretToken(secretHeader, expectedSecret)) {
      return NextResponse.json(
        { success: false, error: "Invalid Telegram webhook secret" },
        { status: 401 },
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

    const rawBody = await request.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const message = body.message as
      | {
          message_id?: number;
          text?: string;
          from?: { first_name?: string };
          chat?: { id?: number };
        }
      | undefined;

    if (!message?.message_id) {
      return NextResponse.json({ success: true, skipped: true }, { status: 200 });
    }

    const text =
      typeof message.text === "string" ? message.text : "";
    const firstName =
      typeof message.from?.first_name === "string"
        ? message.from.first_name
        : "";
    const chatId =
      message.chat?.id !== undefined ? String(message.chat.id) : "";

    const telegramData = {
      text,
      firstName,
      chatId,
      raw: body,
    };

    await sendWorkflowExecution({
      workflowId,
      initialData: {
        telegram: telegramData,
      },
      idempotencyKey: String(message.message_id),
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process Telegram update" },
      { status: 500 },
    );
  }
}
