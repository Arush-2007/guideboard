import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyInstagramWebhookSignature,
  verifyStripeWebhookSignature,
} from "./webhook-verify";

function stripeSignatureHeader(rawBody: string, secret: string, timestamp: number) {
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = Buffer.from(secret, "utf8");
  const v1 = createHmac("sha256", key)
    .update(signedPayload, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

describe("verifyStripeWebhookSignature", () => {
  it("accepts a valid v1 signature (plain UTF-8 secret)", () => {
    const raw = '{"id":"evt_test","type":"test"}';
    const secret = "test_plain_secret";
    const ts = Math.floor(Date.now() / 1000);
    const header = stripeSignatureHeader(raw, secret, ts);
    expect(verifyStripeWebhookSignature(raw, header, secret)).toBe(true);
  });

  it("rejects tampered body", () => {
    const raw = '{"id":"evt_test"}';
    const secret = "test_plain_secret";
    const ts = Math.floor(Date.now() / 1000);
    const header = stripeSignatureHeader(raw, secret, ts);
    expect(verifyStripeWebhookSignature(`${raw}x`, header, secret)).toBe(false);
  });

  it("rejects missing header", () => {
    expect(
      verifyStripeWebhookSignature("{}", null, "secret"),
    ).toBe(false);
  });
});

describe("verifyInstagramWebhookSignature", () => {
  it("accepts a valid sha256 signature", () => {
    const raw = '{"object":"instagram","entry":[]}';
    const secret = "instagram_app_secret";
    const sig =
      "sha256=" +
      createHmac("sha256", secret).update(raw, "utf8").digest("hex");
    expect(verifyInstagramWebhookSignature(raw, sig, secret)).toBe(true);
  });

  it("rejects wrong secret", () => {
    const raw = '{"object":"instagram"}';
    const sig =
      "sha256=" +
      createHmac("sha256", "correct").update(raw, "utf8").digest("hex");
    expect(verifyInstagramWebhookSignature(raw, sig, "wrong")).toBe(false);
  });

  it("rejects missing or malformed header", () => {
    expect(
      verifyInstagramWebhookSignature("{}", null, "secret"),
    ).toBe(false);
    expect(
      verifyInstagramWebhookSignature("{}", "md5=abc", "secret"),
    ).toBe(false);
  });
});
