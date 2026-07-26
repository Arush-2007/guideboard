import { describe, expect, it } from "vitest";
import { googleFormIdempotencyKey } from "./webhook-idempotency";

describe("googleFormIdempotencyKey", () => {
  it("keys on the stable responseId when present", () => {
    expect(googleFormIdempotencyKey("resp_abc")).toBe("google-form:resp_abc");
  });

  it("trims surrounding whitespace on the responseId", () => {
    expect(googleFormIdempotencyKey("  resp_abc  ")).toBe(
      "google-form:resp_abc",
    );
  });

  it("falls back to a per-call timestamp key when responseId is absent", () => {
    for (const missing of [undefined, null, "", "   "]) {
      expect(googleFormIdempotencyKey(missing)).toMatch(/^google-form:\d+$/);
    }
  });
});
