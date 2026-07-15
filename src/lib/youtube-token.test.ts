import ky from "ky";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/lib/db";
import { refreshYoutubeTokenIfNeeded } from "./youtube-token";

vi.mock("@/lib/db", () => ({
  default: {
    youtubeCredential: {
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
  const instance = { post: vi.fn() };
  return {
    default: { ...instance, create: () => instance },
    TimeoutError: class TimeoutError extends Error {},
  };
});

const savedEnv = { ...process.env };

describe("refreshYoutubeTokenIfNeeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.YOUTUBE_CLIENT_ID = "test-client-id";
    process.env.YOUTUBE_CLIENT_SECRET = "test-client-secret";
  });

  afterEach(() => {
    process.env.YOUTUBE_CLIENT_ID = savedEnv.YOUTUBE_CLIENT_ID;
    process.env.YOUTUBE_CLIENT_SECRET = savedEnv.YOUTUBE_CLIENT_SECRET;
  });

  it("throws if no credential found", async () => {
    vi.mocked(prisma.youtubeCredential.findFirst).mockResolvedValue(null);
    await expect(refreshYoutubeTokenIfNeeded("user-1")).rejects.toThrow();
  });

  it("returns token directly if expiresAt is far in future", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    vi.mocked(prisma.youtubeCredential.findFirst).mockResolvedValue({
      id: "cred-1",
      accessToken: "enc:current-token",
      refreshToken: "enc:refresh-token",
      expiresAt,
    } as any);

    const result = await refreshYoutubeTokenIfNeeded("user-1");

    expect(result).toBe("current-token");
    expect(vi.mocked(ky.post)).not.toHaveBeenCalled();
  });

  it("refreshes token when expiresAt is in the past", async () => {
    const expiresAt = new Date(Date.now() - 1000);
    vi.mocked(prisma.youtubeCredential.findFirst).mockResolvedValue({
      id: "cred-1",
      accessToken: "enc:old-token",
      refreshToken: "enc:refresh-token",
      expiresAt,
    } as any);
    vi.mocked(ky.post).mockReturnValue({
      json: vi.fn().mockResolvedValue({
        access_token: "new-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as any);
    vi.mocked(prisma.youtubeCredential.update).mockResolvedValue(
      undefined as any,
    );

    const result = await refreshYoutubeTokenIfNeeded("user-1");

    expect(vi.mocked(prisma.youtubeCredential.update)).toHaveBeenCalled();
    expect(result).toBe("new-token");
  });

  it("throws descriptive error if refresh call fails", async () => {
    vi.mocked(prisma.youtubeCredential.findFirst).mockResolvedValue({
      id: "cred-1",
      accessToken: "enc:token",
      refreshToken: "enc:refresh",
      expiresAt: null,
    } as any);
    vi.mocked(ky.post).mockReturnValue({
      json: vi.fn().mockRejectedValue(new Error("network error")),
    } as any);

    await expect(refreshYoutubeTokenIfNeeded("user-1")).rejects.toThrow(
      "YouTube token refresh failed",
    );
  });

  it("throws if env vars are missing", async () => {
    delete process.env.YOUTUBE_CLIENT_ID;
    vi.mocked(prisma.youtubeCredential.findFirst).mockResolvedValue({
      id: "cred-1",
      accessToken: "enc:token",
      refreshToken: "enc:refresh",
      expiresAt: null,
    } as any);

    await expect(refreshYoutubeTokenIfNeeded("user-1")).rejects.toThrow(
      "YouTube token refresh failed",
    );
  });
});
