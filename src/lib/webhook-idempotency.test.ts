import { describe, expect, it } from "vitest";
import { googleFormIdempotencyKey } from "./webhook-idempotency";

describe("googleFormIdempotencyKey", () => {
  it("keys on the stable responseId when present", () => {
    expect(googleFormIdempotencyKey("wf_1", "resp_abc")).toBe(
      "google-form:wf_1:resp_abc",
    );
  });

  it("trims surrounding whitespace on the responseId", () => {
    expect(googleFormIdempotencyKey("wf_1", "  resp_abc  ")).toBe(
      "google-form:wf_1:resp_abc",
    );
  });

  it("falls back to a per-call timestamp key when responseId is absent", () => {
    for (const missing of [undefined, null, "", "   "]) {
      expect(googleFormIdempotencyKey("wf_1", missing)).toMatch(
        /^google-form:wf_1:\d+$/,
      );
    }
  });
});
