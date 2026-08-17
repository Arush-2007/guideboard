import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { __rateLimitKeyCount, isAllowed } from "./rate-limit";

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

  it("evicts keys that go idle, so a caller-controlled key cannot grow the store forever", () => {
    // The shape of the attack this guards: several routes key by something the
    // requester supplies (a webhook token, a `?workflowId=`), so an anonymous
    // flood of distinct values must not be a permanent allocation.
    const before = __rateLimitKeyCount();
    for (let i = 0; i < 500; i++) {
      isAllowed(`test-rl-flood-${i}`, 100, 1000);
    }
    expect(__rateLimitKeyCount()).toBeGreaterThanOrEqual(before + 500);

    // Past both the window and the sweep interval, one more call reclaims them.
    vi.advanceTimersByTime(61_000);
    isAllowed("test-rl-after-sweep", 1, 1000);

    expect(__rateLimitKeyCount()).toBe(1);
  });
});
