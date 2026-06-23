import { beforeEach, describe, expect, it, vi } from "vitest";

// The helper is the single chokepoint every fetch*RealtimeToken action delegates
// to, so its scoping/auth logic is what actually closes the cross-user leak.
// We mock its server-only collaborators and assert the security invariants:
//   1. no session  -> throws, never mints a token
//   2. with session -> mints a token scoped to THAT user's channel + status topic
const getSession = vi.fn();
const getSubscriptionToken = vi.fn();

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}));
vi.mock("@/inngest/client", () => ({ inngest: { id: "test-app" } }));
vi.mock("@inngest/realtime", () => ({
  getSubscriptionToken: (...args: unknown[]) => getSubscriptionToken(...args),
}));

import { mintUserStatusToken } from "./mint-status-token";

describe("mintUserStatusToken", () => {
  beforeEach(() => {
    getSession.mockReset();
    getSubscriptionToken.mockReset();
  });

  it("throws and mints nothing when there is no session", async () => {
    getSession.mockResolvedValue(null);

    await expect(mintUserStatusToken(() => ({}) as never)).rejects.toThrow(
      /unauthorized/i,
    );
    expect(getSubscriptionToken).not.toHaveBeenCalled();
  });

  it("throws when the session has no user id", async () => {
    getSession.mockResolvedValue({ user: {} });

    await expect(mintUserStatusToken(() => ({}) as never)).rejects.toThrow(
      /unauthorized/i,
    );
    expect(getSubscriptionToken).not.toHaveBeenCalled();
  });

  it("scopes the channel to the SESSION user's id (isolation)", async () => {
    getSession.mockResolvedValue({ user: { id: "user_123" } });
    const scopedChannel = { id: "anthropic-execution:user_123" };
    const channelFor = vi.fn(() => scopedChannel as never);
    getSubscriptionToken.mockResolvedValue({ token: "tok" });

    const result = await mintUserStatusToken(channelFor);

    // The channel factory must be invoked with the authenticated user's id —
    // not any caller-supplied value — so a token can only ever cover that user.
    expect(channelFor).toHaveBeenCalledWith("user_123");
    expect(getSubscriptionToken).toHaveBeenCalledWith(expect.anything(), {
      channel: scopedChannel,
      topics: ["status"],
    });
    expect(result).toEqual({ token: "tok" });
  });
});
