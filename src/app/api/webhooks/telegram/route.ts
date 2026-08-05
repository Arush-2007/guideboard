/**
 * Telegram Bot API webhook. Validates `X-Telegram-Bot-Api-Secret-Token` against
 * TELEGRAM_WEBHOOK_SECRET (same value as setWebhook `secret_token`).
 */

import { type NextRequest, NextResponse } from "next/server";
import { sendWorkflowExecution } from "@/inngest/utils";
import { logger } from "@/lib/logger";
import { isAllowed } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/webhook-verify";

export async function POST(request: NextRequest) {
  try {
    if (!isAllowed("webhook:telegram", 200, 60_000)) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 },
      );
    }

    // Telegram offers no body signature, only a static `secret_token` echoed
    // in a header — so shared-secret is the strongest scheme available here.
    const auth = verifyWebhookRequest({
      request,
      scheme: {
        kind: "shared-secret",
        header: "x-telegram-bot-api-secret-token",
      },
      secret: process.env.TELEGRAM_WEBHOOK_SECRET,
      secretName: "TELEGRAM_WEBHOOK_SECRET",
      invalidMessage: "Invalid Telegram webhook secret",
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

    // Telegram "Message" subset we read. `contact` is only present when the
    // sender shares a contact card (the only way Telegram exposes a phone
    // number) — see https://core.telegram.org/bots/api#message.
    const message = body.message as
      | {
          message_id?: number;
          date?: number;
          text?: string;
          from?: {
            id?: number;
            first_name?: string;
            last_name?: string;
            username?: string;
          };
          chat?: { id?: number };
          contact?: {
            phone_number?: string;
            first_name?: string;
            last_name?: string;
          };
        }
      | undefined;

    if (!message?.message_id) {
      return NextResponse.json(
        { success: true, skipped: true },
        { status: 200 },
      );
    }

    const from = message.from ?? {};
    const chatId =
      message.chat?.id !== undefined ? String(message.chat.id) : "";

    // Stable output contract for the TELEGRAM_TRIGGER node. Keep field paths in
    // sync with `nodeOutputs[TELEGRAM_TRIGGER]` in src/config/node-outputs.ts —
    // that registry is what the field-mapping UI reads to populate upstream
    // fields. `raw` is the full update for power users / templating escape hatch.
    const telegramData = {
      messageId: message.message_id,
      text: typeof message.text === "string" ? message.text : "",
      date: typeof message.date === "number" ? message.date : null,
      from: {
        id: from.id !== undefined ? String(from.id) : "",
        firstName: from.first_name ?? "",
        lastName: from.last_name ?? "",
        username: from.username ?? "",
      },
      chatId,
      contact: message.contact?.phone_number
        ? {
            phoneNumber: message.contact.phone_number,
            firstName: message.contact.first_name ?? "",
          }
        : null,
      raw: body,
    };

    await sendWorkflowExecution({
      workflowId,
      initialData: {
        telegram: telegramData,
      },
      // Telegram's message_id is unique per chat, not globally — key the dedup
      // on chatId + message_id so messages from different chats can't collide.
      idempotencyKey: `telegram:${chatId}:${message.message_id}`,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error("Telegram webhook error", error);
    return NextResponse.json(
      { success: false, error: "Failed to process Telegram update" },
      { status: 500 },
    );
  }
}
