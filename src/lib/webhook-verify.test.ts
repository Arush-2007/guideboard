import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyInstagramWebhookSignature,
  verifyTelegramWebhookSecretToken,
  verifyTypeformWebhookSignature,
} from "./webhook-verify";

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
    expect(verifyInstagramWebhookSignature("{}", null, "secret")).toBe(false);
    expect(verifyInstagramWebhookSignature("{}", "md5=abc", "secret")).toBe(
      false,
    );
  });
});

describe("verifyTypeformWebhookSignature", () => {
  it("accepts a valid sha256 signature", () => {
    const raw = '{"event_type":"form_response","form_response":{"token":"t1"}}';
    const secret = "typeform_webhook_secret";
    const sig =
      "sha256=" +
      createHmac("sha256", secret).update(raw, "utf8").digest("hex");
    expect(verifyTypeformWebhookSignature(raw, sig, secret)).toBe(true);
  });

  it("rejects wrong secret", () => {
    const raw = '{"event_type":"form_response"}';
    const sig =
      "sha256=" +
      createHmac("sha256", "correct").update(raw, "utf8").digest("hex");
    expect(verifyTypeformWebhookSignature(raw, sig, "wrong")).toBe(false);
  });
});

describe("verifyTelegramWebhookSecretToken", () => {
  it("accepts matching secret header", () => {
    const secret = "my_telegram_webhook_secret_1";
    expect(verifyTelegramWebhookSecretToken(secret, secret)).toBe(true);
  });

  it("rejects wrong secret", () => {
    expect(
      verifyTelegramWebhookSecretToken("header-value", "expected"),
    ).toBe(false);
  });

  it("rejects null header or empty expected", () => {
    expect(verifyTelegramWebhookSecretToken(null, "x")).toBe(false);
    expect(verifyTelegramWebhookSecretToken("x", "")).toBe(false);
  });
});
