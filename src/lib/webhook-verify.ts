import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Raw-body HMAC-SHA256 as `sha256=<hex>` (timing-safe compare).
 * Used by Instagram (`X-Hub-Signature-256`) and Typeform (`typeform-signature`).
 */
function verifySha256PrefixedHmac(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Instagram / Meta `X-Hub-Signature-256` — `sha256=<hex>` of raw body using app secret.
 */
export function verifyInstagramWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  return verifySha256PrefixedHmac(rawBody, signatureHeader, appSecret);
}

/**
 * Typeform `typeform-signature` — `sha256=<hex>` of raw body using the webhook secret.
 */
export function verifyTypeformWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  signingSecret: string,
): boolean {
  return verifySha256PrefixedHmac(rawBody, signatureHeader, signingSecret);
}

/**
 * Telegram `X-Telegram-Bot-Api-Secret-Token` must match the webhook `secret_token` / `TELEGRAM_WEBHOOK_SECRET`.
 */
export function verifyTelegramWebhookSecretToken(
  headerValue: string | null,
  expectedSecret: string,
): boolean {
  if (headerValue == null || expectedSecret.length === 0) return false;
  try {
    const a = Buffer.from(headerValue, "utf8");
    const b = Buffer.from(expectedSecret, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
