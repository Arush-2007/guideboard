import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLL_CRON, resolvePollCron } from "./poll-cron";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("resolvePollCron", () => {
  it("uses the default when unset", () => {
    expect(resolvePollCron(undefined)).toBe(DEFAULT_POLL_CRON);
  });

  it("treats an empty or blank override as unset", () => {
    // Emptying an env var is the ordinary way to unset one; `??` would let it
    // through to createFunction as an invalid cron.
    expect(resolvePollCron("")).toBe(DEFAULT_POLL_CRON);
    expect(resolvePollCron("   ")).toBe(DEFAULT_POLL_CRON);
  });

  it("accepts a well-formed override, trimmed", () => {
    expect(resolvePollCron("*/30 * * * *")).toBe("*/30 * * * *");
    expect(resolvePollCron("  0 * * * *  ")).toBe("0 * * * *");
  });

  it("accepts a timezone prefix", () => {
    expect(resolvePollCron("TZ=Asia/Kolkata */15 * * * *")).toBe(
      "TZ=Asia/Kolkata */15 * * * *",
    );
  });

  it("falls back rather than passing a malformed cron to createFunction", () => {
    // One bad cron fails the whole serve() handler, taking executeWorkflow with
    // it — so a typo in an optional knob must degrade, not break the deploy.
    expect(resolvePollCron("*/15")).toBe(DEFAULT_POLL_CRON);
    expect(resolvePollCron("every 15 minutes")).toBe(DEFAULT_POLL_CRON);
    expect(resolvePollCron("* * * * * *")).toBe(DEFAULT_POLL_CRON);
  });

  it("defaults to an interval longer than a serverless idle window", () => {
    // The default exists to let the database's compute suspend; a default at or
    // under five minutes would silently reintroduce always-on billing.
    const minutes = Number(DEFAULT_POLL_CRON.match(/^\*\/(\d+)/)?.[1]);
    expect(minutes).toBeGreaterThan(5);
  });
});
