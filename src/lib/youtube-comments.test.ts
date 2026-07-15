import ky from "ky";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshYoutubeTokenIfNeeded } from "@/lib/youtube-token";
import { fetchNewYoutubeComments } from "./youtube-comments";

vi.mock("@/lib/youtube-token", () => ({
  refreshYoutubeTokenIfNeeded: vi.fn(),
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

describe("fetchNewYoutubeComments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty array when items is undefined", async () => {
    vi.mocked(refreshYoutubeTokenIfNeeded).mockResolvedValue("tok");
    vi.mocked(ky.get).mockReturnValue({
      json: vi.fn().mockResolvedValue({}),
    } as any);

    const result = await fetchNewYoutubeComments("user-1", "vid-1", new Date());

    expect(result).toEqual([]);
  });

  it("maps items to YoutubeComment shape correctly", async () => {
    vi.mocked(refreshYoutubeTokenIfNeeded).mockResolvedValue("tok");
    vi.mocked(ky.get).mockReturnValue({
      json: vi.fn().mockResolvedValue({
        items: [
          {
            id: "comment-1",
            snippet: {
              topLevelComment: {
                snippet: {
                  textDisplay: "Great video!",
                  authorDisplayName: "Alice",
                },
              },
            },
          },
        ],
      }),
    } as any);

    const result = await fetchNewYoutubeComments("user-1", "vid-1", new Date());

    expect(result).toEqual([
      {
        commentId: "comment-1",
        commentText: "Great video!",
        commenterName: "Alice",
        videoId: "vid-1",
      },
    ]);
  });

  it("passes publishedAfter as ISO string in searchParams", async () => {
    const publishedAfter = new Date("2024-06-01T00:00:00.000Z");
    vi.mocked(refreshYoutubeTokenIfNeeded).mockResolvedValue("tok");
    vi.mocked(ky.get).mockReturnValue({
      json: vi.fn().mockResolvedValue({}),
    } as any);

    await fetchNewYoutubeComments("user-1", "vid-1", publishedAfter);

    expect(vi.mocked(ky.get)).toHaveBeenCalledWith(
      "https://www.googleapis.com/youtube/v3/commentThreads",
      expect.objectContaining({
        searchParams: expect.objectContaining({
          publishedAfter: publishedAfter.toISOString(),
        }),
      }),
    );
  });

  it("passes Bearer token in Authorization header", async () => {
    vi.mocked(refreshYoutubeTokenIfNeeded).mockResolvedValue("tok123");
    vi.mocked(ky.get).mockReturnValue({
      json: vi.fn().mockResolvedValue({}),
    } as any);

    await fetchNewYoutubeComments("user-1", "vid-1", new Date());

    expect(vi.mocked(ky.get)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer tok123" },
      }),
    );
  });

  it("throws when ky throws", async () => {
    vi.mocked(refreshYoutubeTokenIfNeeded).mockResolvedValue("tok");
    vi.mocked(ky.get).mockImplementation(() => {
      throw new Error("api error");
    });

    await expect(
      fetchNewYoutubeComments("user-1", "vid-1", new Date()),
    ).rejects.toThrow("api error");
  });
});
