import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookRequest } from "./webhook-verify";

/**
 * `verifyWebhookRequest` is the module's only export, so every primitive is
 * exercised THROUGH it — which is also the only way they are reachable in
 * production. The per-provider wrapper tests this file used to carry asserted
 * one-line aliases that no route called.
 */

describe("verifyWebhookRequest", () => {
  const SECRET = "s3cret-value";

  const post = (opts?: {
    headers?: Record<string, string>;
    body?: string;
    query?: string;
  }) =>
    new Request(`https://app.test/api/webhooks/x${opts?.query ?? ""}`, {
      method: "POST",
      headers: opts?.headers,
      body: opts?.body ?? "{}",
    });

  const sign = (body: string, secret = SECRET) =>
    `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

  describe("unset or placeholder secret", () => {
    // The bug this seam exists to make unrepresentable: no route decides what a
    // missing secret means any more, so no route can decide "allow".
    it("refuses with 503 when the secret is undefined", async () => {
      const result = verifyWebhookRequest({
        request: post({ headers: { "x-secret": SECRET } }),
        scheme: { kind: "shared-secret", header: "x-secret" },
        secret: undefined,
        secretName: "SOME_SECRET",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(503);
      await expect(result.response.json()).resolves.toMatchObject({
        error: expect.stringContaining("SOME_SECRET"),
      });
    });

    it("refuses when the secret is an empty string", () => {
      expect(
        verifyWebhookRequest({
          request: post({ headers: { "x-secret": "" } }),
          scheme: { kind: "shared-secret", header: "x-secret" },
          secret: "",
          secretName: "SOME_SECRET",
        }).ok,
      ).toBe(false);
    });

    it("refuses a still-placeholder secret, even when presented correctly", () => {
      // A placeholder is PUBLIC — anyone reading the repo has it — so it is not
      // a credential, and matching it must not authenticate anyone.
      const placeholder = "your-random-secret-here";
      const result = verifyWebhookRequest({
        request: post({ headers: { "x-secret": placeholder } }),
        scheme: { kind: "shared-secret", header: "x-secret" },
        secret: placeholder,
        secretName: "SOME_SECRET",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(503);
    });

    it("answers 503 rather than 401, so an operator knows who is at fault", () => {
      const result = verifyWebhookRequest({
        request: post(),
        scheme: { kind: "shared-secret", header: "x-secret" },
        secret: undefined,
        secretName: "SOME_SECRET",
      });
      if (!result.ok) expect(result.response.status).toBe(503);
    });
  });

  describe("a DATABASE-sourced secret", () => {
    // Per-row secrets (`WebhookTrigger.secret`) are not environment values, and
    // treating them as such produced a 503 that sent the reader to a `.env`
    // file for a problem sitting in Postgres.

    it("still refuses a blank one", () => {
      const result = verifyWebhookRequest({
        request: post({ headers: { "x-sig": "sha256=whatever" } }),
        scheme: { kind: "hmac-sha256", header: "x-sig" },
        rawBody: "{}",
        secret: "",
        secretName: "WebhookTrigger.secret",
        secretSource: "database",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(503);
    });

    it("names a fix that exists, instead of pointing at .env.example", async () => {
      const result = verifyWebhookRequest({
        request: post(),
        scheme: { kind: "hmac-sha256", header: "x-sig" },
        rawBody: "{}",
        secret: undefined,
        secretName: "WebhookTrigger.secret",
        secretSource: "database",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const { error } = (await result.response.json()) as { error: string };
      expect(error).toContain("Regenerate the webhook");
      expect(error).not.toContain(".env");
    });

    it("does not apply the env placeholder filter to a row's value", () => {
      // Contrived, since generated secrets are hex — but the filter has no
      // business judging a database column, and a value it happens to match
      // must not be refused as if it were an unedited `.env`.
      const dbSecret = "your-imported-legacy-secret";
      const body = "{}";

      const result = verifyWebhookRequest({
        request: post({ headers: { "x-sig": sign(body, dbSecret) }, body }),
        scheme: { kind: "hmac-sha256", header: "x-sig" },
        rawBody: body,
        secret: dbSecret,
        secretName: "WebhookTrigger.secret",
        secretSource: "database",
      });

      expect(result.ok).toBe(true);
    });

    it("still filters placeholders when the secret comes from the env", () => {
      // The default must not have shifted: an unedited `.env` value is public.
      const placeholder = "your-random-secret-here";
      const body = "{}";

      const result = verifyWebhookRequest({
        request: post({ headers: { "x-sig": sign(body, placeholder) }, body }),
        scheme: { kind: "hmac-sha256", header: "x-sig" },
        rawBody: body,
        secret: placeholder,
        secretName: "SOME_SECRET",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(503);
    });
  });

  describe("shared secret", () => {
    it("accepts a matching header", () => {
      expect(
        verifyWebhookRequest({
          request: post({ headers: { "x-secret": SECRET } }),
          scheme: { kind: "shared-secret", header: "x-secret" },
          secret: SECRET,
          secretName: "S",
        }).ok,
      ).toBe(true);
    });

    it("accepts a matching query parameter when one is configured", () => {
      expect(
        verifyWebhookRequest({
          request: post({ query: `?secret=${SECRET}` }),
          scheme: {
            kind: "shared-secret",
            header: "x-secret",
            queryParam: "secret",
          },
          secret: SECRET,
          secretName: "S",
        }).ok,
      ).toBe(true);
    });

    it("ignores a query parameter the scheme does not declare", () => {
      expect(
        verifyWebhookRequest({
          request: post({ query: `?secret=${SECRET}` }),
          scheme: { kind: "shared-secret", header: "x-secret" },
          secret: SECRET,
          secretName: "S",
        }).ok,
      ).toBe(false);
    });

    it("rejects a wrong secret with 401 by default", () => {
      const result = verifyWebhookRequest({
        request: post({ headers: { "x-secret": "wrong" } }),
        scheme: { kind: "shared-secret", header: "x-secret" },
        secret: SECRET,
        secretName: "S",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    });

    it("rejects when no credential is presented at all", () => {
      expect(
        verifyWebhookRequest({
          request: post(),
          scheme: { kind: "shared-secret", header: "x-secret" },
          secret: SECRET,
          secretName: "S",
        }).ok,
      ).toBe(false);
    });
  });

  describe("hmac", () => {
    it("accepts a correct sha256 signature over the raw body", () => {
      const body = JSON.stringify({ hello: "world" });
      expect(
        verifyWebhookRequest({
          request: post({ body, headers: { "x-sig": sign(body) } }),
          rawBody: body,
          scheme: { kind: "hmac-sha256", header: "x-sig" },
          secret: SECRET,
          secretName: "S",
        }).ok,
      ).toBe(true);
    });

    it("rejects a signature computed over DIFFERENT bytes", () => {
      // Why the RAW body is signed: altering it must invalidate the signature.
      const body = JSON.stringify({ hello: "world" });
      expect(
        verifyWebhookRequest({
          request: post({ body, headers: { "x-sig": sign(body) } }),
          rawBody: JSON.stringify({ hello: "tampered" }),
          scheme: { kind: "hmac-sha256", header: "x-sig" },
          secret: SECRET,
          secretName: "S",
        }).ok,
      ).toBe(false);
    });

    it("rejects a signature made with the wrong secret", () => {
      const body = "{}";
      expect(
        verifyWebhookRequest({
          request: post({ body, headers: { "x-sig": sign(body, "other") } }),
          rawBody: body,
          scheme: { kind: "hmac-sha256", header: "x-sig" },
          secret: SECRET,
          secretName: "S",
        }).ok,
      ).toBe(false);
    });

    it("verifies sha1, which PubSubHubbub requires", () => {
      const body = "<feed/>";
      const sig = `sha1=${createHmac("sha1", SECRET).update(body, "utf8").digest("hex")}`;
      expect(
        verifyWebhookRequest({
          request: post({ body, headers: { "x-sig": sig } }),
          rawBody: body,
          scheme: { kind: "hmac-sha1", header: "x-sig" },
          secret: SECRET,
          secretName: "S",
        }).ok,
      ).toBe(true);
    });

    it("honours a route overriding the status for a bad credential", () => {
      // Instagram answers 403 and Typeform 400; the seam must not change what a
      // provider already observes on failure.
      const result = verifyWebhookRequest({
        request: post({ headers: { "x-sig": "sha256=deadbeef" } }),
        rawBody: "{}",
        scheme: { kind: "hmac-sha256", header: "x-sig" },
        secret: SECRET,
        secretName: "S",
        invalidStatus: 403,
      });
      if (!result.ok) expect(result.response.status).toBe(403);
    });
  });

  describe("mode if-present", () => {
    it("passes when the caller sent no signature", () => {
      // The generic webhook: an unguessable URL token is the baseline auth, and
      // signing is opt-in on top of it.
      expect(
        verifyWebhookRequest({
          request: post(),
          rawBody: "{}",
          scheme: { kind: "hmac-sha256", header: "x-sig" },
          secret: SECRET,
          secretName: "S",
          mode: "if-present",
        }).ok,
      ).toBe(true);
    });

    it("still rejects a signature that is present and wrong", () => {
      expect(
        verifyWebhookRequest({
          request: post({ headers: { "x-sig": "sha256=nope" } }),
          rawBody: "{}",
          scheme: { kind: "hmac-sha256", header: "x-sig" },
          secret: SECRET,
          secretName: "S",
          mode: "if-present",
        }).ok,
      ).toBe(false);
    });

    it("does NOT excuse an unset secret", () => {
      // "if-present" relaxes the credential, never the configuration.
      const result = verifyWebhookRequest({
        request: post(),
        rawBody: "{}",
        scheme: { kind: "hmac-sha256", header: "x-sig" },
        secret: undefined,
        secretName: "S",
        mode: "if-present",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(503);
    });
  });
});
