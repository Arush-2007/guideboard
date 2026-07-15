import { NonRetriableError, RetryAfterError } from "inngest";
import { TimeoutError } from "ky";
import { describe, expect, it } from "vitest";
import {
  assertTimeoutBudget,
  asTimeoutError,
  clampUserTimeout,
  DEFAULT_USER_TIMEOUT_MS,
  HTTP_TIMEOUT,
  isTimeout,
  MAX_STEP_BUDGET_MS,
  MAX_USER_TIMEOUT_MS,
  rethrowTimeout,
  STEP_OVERHEAD_MS,
  timeoutSignal,
  WORST_CASE_STEP_MS,
} from "./http";

/** ky's TimeoutError only needs a Request to construct. */
const kyTimeout = () =>
  new TimeoutError(new Request("https://sheets.googleapis.com/v4/x"));

/** What `AbortSignal.timeout()` rejects with — a DOMException, NOT ky's class. */
const abortTimeout = () =>
  new DOMException("The operation was aborted due to timeout", "TimeoutError");

describe("the budget assertion", () => {
  it("passes with the shipped table (the app must boot)", () => {
    expect(() => assertTimeoutBudget()).not.toThrow();
  });

  it("counts a token refresh as nested INSIDE the call it guards", () => {
    // The trap this catches: costing a Sheets read at 30s when it really costs
    // TOKEN(10s) + READ(30s) = 40s, and under-reserving the budget by 10s.
    expect(WORST_CASE_STEP_MS).toBeGreaterThanOrEqual(
      HTTP_TIMEOUT.TOKEN + HTTP_TIMEOUT.READ,
    );
  });

  it("throws when the table cannot fit under the platform ceiling", () => {
    // A 120s step against a 60s ceiling: the platform kills the call before our
    // timeout fires, and it surfaces as an opaque platform error, not a node failure.
    expect(() => assertTimeoutBudget(60_000, 5_000, 120_000)).toThrow(
      /timeout budget exceeded/i,
    );
  });

  it("leaves real headroom under the ceiling, not a hairline fit", () => {
    expect(WORST_CASE_STEP_MS + STEP_OVERHEAD_MS).toBeLessThanOrEqual(
      MAX_STEP_BUDGET_MS,
    );
  });
});

describe("isTimeout", () => {
  it("recognises ky's TimeoutError", () => {
    expect(isTimeout(kyTimeout())).toBe(true);
  });

  it("recognises AbortSignal.timeout's DOMException", () => {
    // These are different types that mean the same thing. Missing this one is how
    // the raw-fetch sites would keep hanging silently.
    expect(isTimeout(abortTimeout())).toBe(true);
  });

  it("does not claim an unrelated abort", () => {
    expect(isTimeout(new DOMException("user cancelled", "AbortError"))).toBe(
      false,
    );
    expect(isTimeout(new Error("boom"))).toBe(false);
  });
});

describe("asTimeoutError", () => {
  it("names the integration, the clock, and the remedy", () => {
    const err = asTimeoutError(kyTimeout(), {
      integration: "Google Sheets",
      timeoutClass: "READ",
      idempotent: true,
      hint: "The tab may be very large — narrow the range.",
    });

    // The whole point: NOT "Request timed out: GET https://sheets.googleapis.com/…"
    expect(err?.message).toContain("Google Sheets");
    expect(err?.message).toContain("30s");
    expect(err?.message).toContain("narrow the range");
  });

  it("retries an IDEMPOTENT timeout, so Inngest backs off and re-attempts", () => {
    const err = asTimeoutError(kyTimeout(), {
      integration: "Google Sheets",
      timeoutClass: "READ",
      idempotent: true,
    });
    expect(err).toBeInstanceOf(RetryAfterError);
  });

  it("does NOT retry a non-idempotent timeout — the request may already have landed", () => {
    // The correctness trade-off, pinned. A timed-out append may have SAVED; retrying
    // writes the row twice, and silent duplicate data is worse to discover than a
    // visible failed run. Flipping this must be deliberate.
    const err = asTimeoutError(kyTimeout(), {
      integration: "Google Sheets",
      timeoutClass: "WRITE",
      idempotent: false,
    });
    expect(err).toBeInstanceOf(NonRetriableError);
    expect(err?.message).toMatch(/may already have gone through/i);
  });

  it("keeps the two axes independent: a SLOW call can still be safe to retry", () => {
    // Lever's create-opportunity is SLOW_API + non-idempotent; Affinda's match is
    // SLOW_API + idempotent. The class must not decide the retry policy.
    const safe = asTimeoutError(kyTimeout(), {
      integration: "Affinda",
      timeoutClass: "SLOW_API",
      idempotent: true,
    });
    const unsafe = asTimeoutError(kyTimeout(), {
      integration: "Lever",
      timeoutClass: "SLOW_API",
      idempotent: false,
    });
    expect(safe).toBeInstanceOf(RetryAfterError);
    expect(unsafe).toBeInstanceOf(NonRetriableError);
  });

  it("classifies a raw-fetch abort exactly like a ky timeout", () => {
    const err = asTimeoutError(abortTimeout(), {
      integration: "CloudConvert",
      timeoutClass: "MEDIA",
      idempotent: true,
    });
    expect(err).toBeInstanceOf(RetryAfterError);
    expect(err?.message).toContain("CloudConvert");
  });

  it("reports the ACTUAL clock when the caller overrides it", () => {
    // HTTP_REQUEST lets the user set the timeout. Without `timeoutMs` the message
    // would quote the class default (30s) for a call the user gave 50s.
    const err = asTimeoutError(kyTimeout(), {
      integration: "The API at https://slow.example",
      timeoutClass: "WRITE",
      idempotent: false,
      timeoutMs: 50_000,
    });
    expect(err?.message).toContain("50s");
    expect(err?.message).not.toContain("30s");
  });

  it("returns null for a non-timeout, so callers can chain", () => {
    expect(
      asTimeoutError(new Error("500"), {
        integration: "Google Sheets",
        timeoutClass: "READ",
        idempotent: true,
      }),
    ).toBeNull();
  });
});

describe("rethrowTimeout", () => {
  const context = {
    integration: "Google Sheets",
    timeoutClass: "READ",
    idempotent: true,
  } as const;

  it("converts a timeout into the classified error", () => {
    expect(() => rethrowTimeout(context)(kyTimeout())).toThrow(RetryAfterError);
  });

  it("rethrows a non-timeout completely untouched", () => {
    // Load-bearing: an HTTPError must reach the provider's own mapper (toSheetsError)
    // with its response intact, or 4xx/429 handling silently dies.
    const original = new Error("HTTP 429");
    expect(() => rethrowTimeout(context)(original)).toThrow(original);
  });
});

describe("timeoutSignal", () => {
  it("produces a signal that is not already aborted", () => {
    const signal = timeoutSignal("MEDIA");
    expect(signal.aborted).toBe(false);
  });
});

describe("clampUserTimeout", () => {
  it("keeps a sane user value as-is", () => {
    expect(clampUserTimeout(20_000)).toBe(20_000);
  });

  it("clamps a value the platform would kill anyway", () => {
    // A user asking for 300s under a 60s ceiling does not GET 300s — they get an
    // opaque platform kill. Clamping turns that into a clean, explainable failure.
    expect(clampUserTimeout(300_000)).toBe(MAX_USER_TIMEOUT_MS);
    expect(MAX_USER_TIMEOUT_MS).toBeLessThan(MAX_STEP_BUDGET_MS);
  });

  it("falls back to the default rather than throwing on junk", () => {
    // A bad number in a config field must not fail a run that would otherwise work.
    for (const junk of [undefined, null, "", "abc", 0, -5, Number.NaN]) {
      expect(clampUserTimeout(junk)).toBe(DEFAULT_USER_TIMEOUT_MS);
    }
  });
});

describe("the timeout table", () => {
  it("fails a human faster than a background step", () => {
    // The classification axis: nobody is watching a background step, so it should be
    // patient; a human on a spinner should not be.
    expect(HTTP_TIMEOUT.INTERACTIVE).toBeLessThan(HTTP_TIMEOUT.READ);
  });

  it("gives a token refresh less room than the call it runs inside", () => {
    expect(HTTP_TIMEOUT.TOKEN).toBeLessThan(HTTP_TIMEOUT.READ);
  });
});
