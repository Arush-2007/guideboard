import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isAllowed } from "./rate-limit";

describe("isAllowed", () => {
  beforeAll(() => vi.useFakeTimers());
  afterAll(() => vi.useRealTimers());
  beforeEach(() => vi.clearAllMocks());

  it("allows the first request", () => {
    expect(isAllowed("test-rl-1", 3, 1000)).toBe(true);
  });

  it("allows requests up to the limit", () => {
    expect(isAllowed("test-rl-2", 3, 1000)).toBe(true);
    expect(isAllowed("test-rl-2", 3, 1000)).toBe(true);
    expect(isAllowed("test-rl-2", 3, 1000)).toBe(true);
  });

  it("blocks the request that exceeds the limit", () => {
    isAllowed("test-rl-3", 2, 1000);
    isAllowed("test-rl-3", 2, 1000);
    expect(isAllowed("test-rl-3", 2, 1000)).toBe(false);
  });

  it("resets after the window expires", () => {
    const windowMs = 1000;
    isAllowed("test-rl-4", 1, windowMs);
    expect(isAllowed("test-rl-4", 1, windowMs)).toBe(false);
    vi.advanceTimersByTime(windowMs + 1);
    expect(isAllowed("test-rl-4", 1, windowMs)).toBe(true);
  });

  it("tracks different keys independently", () => {
    isAllowed("test-rl-5a", 1, 1000);
    expect(isAllowed("test-rl-5a", 1, 1000)).toBe(false);
    expect(isAllowed("test-rl-5b", 1, 1000)).toBe(true);
  });
});
