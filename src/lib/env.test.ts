import { describe, expect, it } from "vitest";
import { env, hasEnv, isRealEnvValue, requireEnv } from "./env";

describe("isRealEnvValue", () => {
  it("rejects unset and blank values", () => {
    expect(isRealEnvValue(undefined)).toBe(false);
    expect(isRealEnvValue("")).toBe(false);
    expect(isRealEnvValue("   ")).toBe(false);
  });

  it("rejects every placeholder shape .env.example actually ships", () => {
    // Taken verbatim from .env.example — the three forms are a bare start,
    // a provider prefix, and a URL scheme.
    for (const placeholder of [
      "your-cloudflare-account-id",
      "your-r2-bucket-name",
      "your-cloudconvert-api-key",
      "your_instagram_app_id_here",
      "your_random_youtube_verify_token_here",
      "re_your_resend_api_key",
      "sntrys_your_ci_only_auth_token",
      "https://your-ngrok-domain.ngrok-free.app",
      "https://your-key@oXXXX.ingest.sentry.io/XXXX",
      "your-Claude-Key",
    ]) {
      expect(isRealEnvValue(placeholder), placeholder).toBe(false);
    }
  });

  it("ignores surrounding whitespace", () => {
    expect(isRealEnvValue("  your-r2-bucket-name  ")).toBe(false);
  });

  it("accepts real credentials, including ones containing 'your'", () => {
    // The `-`/`_` separator is what makes this safe: `yourcompany` is a real
    // name, `your-company` is a placeholder.
    for (const real of [
      "bd4ddd3dd10861de86700d2de588a732",
      "yourcompany-prod-assets",
      "sk-ant-api03-abc123",
      "re_ABC123def456",
      "https://cdn.acme.com",
      "keyoursecret",
    ]) {
      expect(isRealEnvValue(real), real).toBe(true);
    }
  });
});

describe("env", () => {
  it("collapses a placeholder to undefined, so `?? fallback` covers it", () => {
    expect(env("your-r2-bucket-name")).toBeUndefined();
    expect(env("your-r2-bucket-name") ?? "fallback").toBe("fallback");
  });

  it("collapses unset and blank to undefined too", () => {
    expect(env(undefined)).toBeUndefined();
    expect(env("  ")).toBeUndefined();
  });

  it("returns a real value, trimmed", () => {
    expect(env("  sk-ant-real  ")).toBe("sk-ant-real");
  });
});

describe("hasEnv", () => {
  it("is true only when every value is real", () => {
    expect(hasEnv("a", "b")).toBe(true);
    expect(hasEnv("a", undefined)).toBe(false);
    expect(hasEnv("a", "your-thing")).toBe(false);
  });

  it("is vacuously true for no values", () => {
    expect(hasEnv()).toBe(true);
  });
});

describe("requireEnv", () => {
  it("returns a real value", () => {
    expect(requireEnv("real-key", "SOME_KEY")).toBe("real-key");
  });

  it("throws naming the variable, for a placeholder as well as unset", () => {
    expect(() => requireEnv("your-key", "SOME_KEY")).toThrow(/SOME_KEY/);
    expect(() => requireEnv("your-key", "SOME_KEY")).toThrow(/placeholder/);
    expect(() => requireEnv(undefined, "SOME_KEY")).toThrow(/SOME_KEY/);
  });
});

describe("requireEnv — integration label", () => {
  it("names the friendly noun AND the variable to edit", () => {
    expect(() =>
      requireEnv(undefined, "CLOUDCONVERT_API_KEY", "CloudConvert"),
    ).toThrow(/CloudConvert is not configured/);
    expect(() =>
      requireEnv(undefined, "CLOUDCONVERT_API_KEY", "CloudConvert"),
    ).toThrow(/set CLOUDCONVERT_API_KEY/);
  });
});
