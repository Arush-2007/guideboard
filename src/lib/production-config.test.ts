import { describe, expect, it } from "vitest";
import {
  describeMissingSettings,
  missingProductionSettings,
} from "./production-config";

const setting = (key: string, value: string | undefined) => ({
  key,
  value,
  because: "it matters",
});

describe("missingProductionSettings", () => {
  it("reports nothing when every setting is real", () => {
    expect(
      missingProductionSettings([
        setting("ENCRYPTION_KEY", "a-real-64-char-secret"),
        setting("BETTER_AUTH_SECRET", "another-real-secret"),
      ]),
    ).toEqual([]);
  });

  it("reports an unset setting", () => {
    const missing = missingProductionSettings([
      setting("ENCRYPTION_KEY", undefined),
    ]);
    expect(missing.map((s) => s.key)).toEqual(["ENCRYPTION_KEY"]);
  });

  it("reports a blank setting", () => {
    expect(
      missingProductionSettings([setting("BETTER_AUTH_SECRET", "   ")]),
    ).toHaveLength(1);
  });

  it("reports every placeholder style .env.example actually uses", () => {
    // The gap that made this check worth writing: the original placeholder
    // pattern matched only `your-…`, so `ENCRYPTION_KEY` and `DATABASE_URL` —
    // the two whose placeholders are most damaging to ship — read as real.
    const missing = missingProductionSettings([
      setting("A", "your-github-client-id"),
      setting("B", "replace-with-a-long-random-secret"),
      setting("C", "postgresql://USER:PASSWORD@HOST:5432/DB_NAME"),
      setting("D", "re_your_resend_api_key"),
    ]);
    expect(missing.map((s) => s.key)).toEqual(["A", "B", "C", "D"]);
  });

  it("does NOT flag genuine values that merely resemble placeholders", () => {
    // A false positive here refuses to boot a correctly configured deployment,
    // so the patterns require a separator rather than matching the bare word.
    expect(
      missingProductionSettings([
        setting("A", "yourcompany-prod-assets"),
        setting("B", "postgresql://appuser:s3cret@db.internal:5432/guideboard"),
        setting("C", "replacements-service-key"),
      ]),
    ).toEqual([]);
  });
});

describe("describeMissingSettings", () => {
  it("names every missing key and why it matters", () => {
    const message = describeMissingSettings([
      { key: "ENCRYPTION_KEY", value: undefined, because: "tokens need it" },
      { key: "INNGEST_SIGNING_KEY", value: undefined, because: "runs need it" },
    ]);

    expect(message).toContain("ENCRYPTION_KEY");
    expect(message).toContain("tokens need it");
    expect(message).toContain("INNGEST_SIGNING_KEY");
    expect(message).toContain("2 required settings are");
  });

  it("reads correctly for a single missing setting", () => {
    const message = describeMissingSettings([
      { key: "ENCRYPTION_KEY", value: undefined, because: "tokens need it" },
    ]);
    expect(message).toContain("1 required setting is");
  });

  it("explains that a placeholder is public, not a secret", () => {
    // The operator's likely reaction is "but it has a value" — the message has
    // to answer that, or the fix looks arbitrary.
    const message = describeMissingSettings([
      { key: "ENCRYPTION_KEY", value: "your-key", because: "tokens need it" },
    ]);
    expect(message).toContain("PUBLIC");
  });
});
