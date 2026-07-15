import ky from "ky";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/lib/db";
import { refreshInstagramTokenIfNeeded } from "./instagram-token";

vi.mock("@/lib/db", () => ({
  default: {
    instagramCredential: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/encryption", () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v.replace("enc:", "")),
}));

// HTTP goes through the shared client in `http.ts` (`ky.create(...)`), so the
// mock must answer `create` with the same fake instance.
vi.mock("ky", () => {
  const instance = { get: vi.fn() };
  return {
    default: { ...instance, create: () => instance },
    TimeoutError: class TimeoutError extends Error {},
  };
});

describe("refreshInstagramTokenIfNeeded", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns early if no credential found", async () => {
    vi.mocked(prisma.instagramCredential.findFirst).mockResolvedValue(null);

    await refreshInstagramTokenIfNeeded("user-1");

    expect(vi.mocked(ky.get)).not.toHaveBeenCalled();
  });

  it("returns early if token expires more than 10 days away", async () => {
    const tokenExpiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    vi.mocked(prisma.instagramCredential.findFirst).mockResolvedValue({
      id: "cred-1",
      accessToken: "enc:token",
      tokenExpiresAt,
    } as any);

    await refreshInstagramTokenIfNeeded("user-1");

    expect(vi.mocked(ky.get)).not.toHaveBeenCalled();
  });

  it("refreshes token when within 10 days of expiry", async () => {
    const tokenExpiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    vi.mocked(prisma.instagramCredential.findFirst).mockResolvedValue({
      id: "cred-1",
      accessToken: "enc:old-token",
      tokenExpiresAt,
    } as any);
    vi.mocked(ky.get).mockReturnValue({
      json: vi.fn().mockResolvedValue({
        access_token: "refreshed-token",
        expires_in: 5184000,
      }),
    } as any);
    vi.mocked(prisma.instagramCredential.update).mockResolvedValue(
      undefined as any,
    );

    await refreshInstagramTokenIfNeeded("user-1");

    expect(vi.mocked(prisma.instagramCredential.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accessToken: "enc:refreshed-token" }),
      }),
    );
  });

  it("throws when the refresh HTTP call fails", async () => {
    const tokenExpiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    vi.mocked(prisma.instagramCredential.findFirst).mockResolvedValue({
      id: "cred-1",
      accessToken: "enc:token",
      tokenExpiresAt,
    } as any);
    vi.mocked(ky.get).mockReturnValue({
      json: vi.fn().mockRejectedValue(new Error("network error")),
    } as any);

    await expect(refreshInstagramTokenIfNeeded("user-1")).rejects.toThrow();
  });
});
