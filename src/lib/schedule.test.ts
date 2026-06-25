import { describe, expect, it } from "vitest";
import { computeNextRunAt, isValidSchedule, isValidTimezone } from "./schedule";

describe("isValidTimezone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
  });

  it("rejects empty or bogus zones", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });
});

describe("isValidSchedule", () => {
  it("accepts a valid cron + timezone", () => {
    expect(isValidSchedule("0 9 * * *", "America/New_York")).toBe(true);
    expect(isValidSchedule("*/5 * * * *", "UTC")).toBe(true);
  });

  it("rejects an unparseable cron", () => {
    expect(isValidSchedule("not a cron", "UTC")).toBe(false);
    expect(isValidSchedule("99 99 * * *", "UTC")).toBe(false);
  });

  it("rejects a valid cron with a bogus timezone", () => {
    expect(isValidSchedule("0 9 * * *", "Not/AZone")).toBe(false);
  });
});

describe("computeNextRunAt", () => {
  it("resolves a daily time in the given timezone (UTC offset applied)", () => {
    // 09:00 in New York during EDT (UTC-4) is 13:00 UTC.
    const next = computeNextRunAt(
      "0 9 * * *",
      "America/New_York",
      new Date("2026-06-25T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-06-25T13:00:00.000Z");
  });

  it("is exclusive of `from` — a time exactly at a firing advances to the next", () => {
    // Starting AT the 13:00 UTC firing must return the following day's firing.
    const next = computeNextRunAt(
      "0 9 * * *",
      "America/New_York",
      new Date("2026-06-25T13:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-06-26T13:00:00.000Z");
  });

  it("handles a spring-forward DST boundary deterministically", () => {
    // US spring-forward 2026-03-08: clocks jump 02:00 -> 03:00 (EST->EDT), so a
    // daily 02:30 schedule has no literal 02:30 that day. cron-parser resolves
    // it to a concrete UTC instant rather than skipping or throwing.
    const next = computeNextRunAt(
      "30 2 * * *",
      "America/New_York",
      new Date("2026-03-07T12:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("computes hourly schedules off an arbitrary instant", () => {
    const next = computeNextRunAt(
      "15 * * * *",
      "UTC",
      new Date("2026-06-25T10:20:00Z"),
    );
    expect(next.toISOString()).toBe("2026-06-25T11:15:00.000Z");
  });
});
