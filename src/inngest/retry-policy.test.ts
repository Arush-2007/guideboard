import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_RETRIES,
  DEFAULT_PRODUCTION_RETRIES,
  MAX_INNGEST_RETRIES,
  resolveWorkflowRetries,
} from "./retry-policy";

describe("resolveWorkflowRetries", () => {
  it("retries once in dev, so a transient blip is not fatal", () => {
    expect(resolveWorkflowRetries({ NODE_ENV: "development" })).toBe(
      DEFAULT_DEV_RETRIES,
    );
    expect(DEFAULT_DEV_RETRIES).toBeGreaterThan(0);
  });

  it("keeps production at 3", () => {
    expect(resolveWorkflowRetries({ NODE_ENV: "production" })).toBe(
      DEFAULT_PRODUCTION_RETRIES,
    );
  });

  it("treats test/unset NODE_ENV as dev", () => {
    expect(resolveWorkflowRetries({})).toBe(DEFAULT_DEV_RETRIES);
    expect(resolveWorkflowRetries({ NODE_ENV: "test" })).toBe(
      DEFAULT_DEV_RETRIES,
    );
  });

  it("honours an explicit override in either direction", () => {
    expect(
      resolveWorkflowRetries({ INNGEST_RETRIES: "5", NODE_ENV: "development" }),
    ).toBe(5);
    // 0 is a legitimate override — "fail immediately, I'm reproducing a bug".
    expect(
      resolveWorkflowRetries({ INNGEST_RETRIES: "0", NODE_ENV: "production" }),
    ).toBe(0);
  });

  it("clamps above Inngest's ceiling rather than failing registration", () => {
    expect(resolveWorkflowRetries({ INNGEST_RETRIES: "999" })).toBe(
      MAX_INNGEST_RETRIES,
    );
  });

  it("ignores a malformed override instead of coercing it to 0", () => {
    // The whole point: `Number("")` and `Number("abc")` must NOT become "never
    // retry", which is the failure mode this resolver exists to prevent.
    for (const bad of ["", "   ", "abc", "-1", "1.5", "1e3x"]) {
      expect(resolveWorkflowRetries({ INNGEST_RETRIES: bad })).toBe(
        DEFAULT_DEV_RETRIES,
      );
    }
  });

  it("tolerates surrounding whitespace on a valid value", () => {
    expect(resolveWorkflowRetries({ INNGEST_RETRIES: "  2  " })).toBe(2);
  });
});
