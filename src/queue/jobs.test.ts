import { RetryAfterError } from "inngest";
import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  parseRetryAfterMs,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
} from "./jobs";

/**
 * The two pure decisions in the queue: how long to wait before the next attempt,
 * and how to read what a provider asked for. Everything else in `jobs.ts` is
 * database behaviour and is proved in `jobs.integration.test.ts` instead.
 */

describe("computeBackoffMs", () => {
  it("doubles the ceiling per attempt, starting at the base", () => {
    // `random` fixed at its maximum so the ceiling itself is observable —
    // otherwise every assertion here would be about a random number.
    const max = () => 1;
    expect(computeBackoffMs(1, max)).toBe(RETRY_BASE_MS);
    expect(computeBackoffMs(2, max)).toBe(RETRY_BASE_MS * 2);
    expect(computeBackoffMs(3, max)).toBe(RETRY_BASE_MS * 4);
    expect(computeBackoffMs(4, max)).toBe(RETRY_BASE_MS * 8);
  });

  it("clamps at the cap, including for absurd attempt counts", () => {
    const max = () => 1;
    expect(computeBackoffMs(100, max)).toBe(RETRY_CAP_MS);
    // 2 ** 1000 is Infinity. Math.min resolves that to the cap rather than
    // producing NaN and an invalid interval.
    expect(computeBackoffMs(1001, max)).toBe(RETRY_CAP_MS);
  });

  it("applies FULL jitter — the delay spans zero to the ceiling", () => {
    // Full rather than equal jitter because a provider outage fails many
    // workflows at once and they must not resynchronise on recovery. The
    // distinguishing property is that the low end reaches zero.
    expect(computeBackoffMs(3, () => 0)).toBe(0);
    expect(computeBackoffMs(3, () => 0.5)).toBe(RETRY_BASE_MS * 2);
    expect(computeBackoffMs(3, () => 1)).toBe(RETRY_BASE_MS * 4);
  });

  it("treats a first attempt and a zeroth identically", () => {
    // `attempt` is 1-based (incremented on claim), but a caller passing 0 must
    // not produce a fractional exponent and a sub-base delay.
    expect(computeBackoffMs(0, () => 1)).toBe(RETRY_BASE_MS);
  });
});

describe("parseRetryAfterMs", () => {
  it("reads a bare number as SECONDS, not milliseconds", () => {
    // The SDK's own doc comment says milliseconds; its constructor stores
    // Math.ceil(ms / 1000). Believing the comment would make every rate-limit
    // wait 1000x too short, so this asserts the code's behaviour.
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs("1")).toBe(1_000);
  });

  it("reads what RetryAfterError actually stores, for each producer's input", () => {
    // The four producers in this codebase all pass ms-style strings; the SDK
    // converts them to seconds before storing. Constructing the real error is
    // what makes this a test of the contract rather than of a string.
    expect(parseRetryAfterMs(new RetryAfterError("x", "30s").retryAfter)).toBe(
      30_000,
    );
    expect(parseRetryAfterMs(new RetryAfterError("x", 5_000).retryAfter)).toBe(
      5_000,
    );
  });

  it("reads an RFC3339 date as a duration from now", () => {
    // The defensive branch: a Date is stored as an ISO string. Not produced
    // anywhere in this codebase today, but the SDK can produce it.
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    const error = new RetryAfterError("x", new Date(now + 45_000));
    expect(parseRetryAfterMs(error.retryAfter, now)).toBe(45_000);
  });

  it("never returns a negative delay for a date already past", () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z");
    expect(parseRetryAfterMs("2026-08-05T11:59:00.000Z", now)).toBe(0);
  });

  it("returns null for anything it cannot read, so the backoff stands", () => {
    // Number("") is 0, which would mean "retry immediately" — the exact wrong
    // answer for a value that carries no information at all.
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("   ")).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs("NaN")).toBeNull();
    // Infinity is finite-checked, not merely numeric-checked.
    expect(parseRetryAfterMs("Infinity")).toBeNull();
  });
});
