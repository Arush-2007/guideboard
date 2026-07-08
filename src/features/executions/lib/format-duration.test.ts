import { describe, expect, it } from "vitest";
import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it("renders sub-second durations in milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(999)).toBe("999ms");
    // rounds fractional ms
    expect(formatDuration(340.7)).toBe("341ms");
  });

  it("renders seconds with one decimal, dropping a trailing .0", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(4300)).toBe("4.3s");
    expect(formatDuration(4000)).toBe("4s");
    // rounds to one decimal
    expect(formatDuration(1249)).toBe("1.2s");
  });

  it("renders minutes and seconds at or above 60s", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(formatDuration(120000)).toBe("2m");
    expect(formatDuration(125000)).toBe("2m 5s");
    // seconds that round up to a full minute roll over cleanly
    expect(formatDuration(119600)).toBe("2m");
  });

  it("promotes to minutes at the 60s rounding boundary (never '60s')", () => {
    // 59.96s would print as "60.0s" under naive rounding — must read "1m".
    expect(formatDuration(59960)).toBe("1m");
    // Just below the boundary still reads in seconds.
    expect(formatDuration(59900)).toBe("59.9s");
  });

  it("collapses missing or invalid durations to an em dash", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
