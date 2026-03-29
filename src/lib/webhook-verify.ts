import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe webhook signing secret: `whsec_` + base64 (see Stripe docs).
 */
function stripeSigningSecretKey(signingSecret: string): Buffer {
  if (signingSecret.startsWith("whsec_")) {
    return Buffer.from(signingSecret.slice(6), "base64");
  }
  return Buffer.from(signingSecret, "utf8");
}

/**
 * Verifies `Stripe-Signature` header for the raw JSON body.
 * @returns `true` if at least one `v1` signature matches and timestamp is within tolerance.
 */
export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  signingSecret: string,
  toleranceSeconds = 300,
): boolean {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(",").map((p) => p.trim());
  let timestamp: string | null = null;
  const v1Signatures: string[] = [];

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") timestamp = value;
    if (key === "v1") v1Signatures.push(value);
  }

  if (!timestamp || v1Signatures.length === 0) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = stripeSigningSecretKey(signingSecret);
  const expected = createHmac("sha256", key)
    .update(signedPayload, "utf8")
    .digest("hex");

  try {
    const expectedBuf = Buffer.from(expected, "hex");
    return v1Signatures.some((sig) => {
      try {
        const sigBuf = Buffer.from(sig, "hex");
        return (
          sigBuf.length === expectedBuf.length &&
          timingSafeEqual(sigBuf, expectedBuf)
        );
      } catch {
        return false;
      }
    });
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
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected =
    "sha256=" +
    createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
