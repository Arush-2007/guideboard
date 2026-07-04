import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSignedBlobUrlMock, isBlobConfiguredMock } = vi.hoisted(() => ({
  getSignedBlobUrlMock: vi.fn(),
  isBlobConfiguredMock: vi.fn(() => true),
}));
vi.mock("@/lib/blob", () => ({
  getSignedBlobUrl: getSignedBlobUrlMock,
  isBlobConfigured: isBlobConfiguredMock,
}));

import { refreshBlobUrls } from "./refresh-blob-urls";

const handle = {
  key: "conversions/u1/e1/n1.png",
  url: "https://r2.example/stale?sig=old",
  contentType: "image/png",
  byteLength: 2,
};

beforeEach(() => {
  getSignedBlobUrlMock
    .mockReset()
    .mockResolvedValue("https://r2.example/fresh");
  isBlobConfiguredMock.mockReset().mockReturnValue(true);
  vi.stubEnv("R2_PUBLIC_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("refreshBlobUrls", () => {
  it("re-signs a nested BlobHandle and any string copies of its stale URL", async () => {
    const stored = {
      CONVERT_1: {
        // Convert duplicates the file URL into `result` as a plain string.
        result: "https://r2.example/stale?sig=old",
        file: handle,
      },
    };

    const refreshed = (await refreshBlobUrls(stored)) as typeof stored;

    expect(getSignedBlobUrlMock).toHaveBeenCalledWith(handle.key);
    expect(refreshed.CONVERT_1.file.url).toBe("https://r2.example/fresh");
    expect(refreshed.CONVERT_1.result).toBe("https://r2.example/fresh");
    // Non-URL fields survive untouched.
    expect(refreshed.CONVERT_1.file.contentType).toBe("image/png");
  });

  it("is a no-op when a public base URL is configured", async () => {
    vi.stubEnv("R2_PUBLIC_BASE_URL", "https://cdn.example.com");
    const stored = { file: handle };
    expect(await refreshBlobUrls(stored)).toBe(stored);
    expect(getSignedBlobUrlMock).not.toHaveBeenCalled();
  });

  it("is a no-op when R2 is not configured", async () => {
    isBlobConfiguredMock.mockReturnValue(false);
    const stored = { file: handle };
    expect(await refreshBlobUrls(stored)).toBe(stored);
    expect(getSignedBlobUrlMock).not.toHaveBeenCalled();
  });

  it("leaves objects with foreign `key` fields alone", async () => {
    const stored = {
      lookup: { key: "customer-42", url: "https://example.com/x" },
    };
    expect(await refreshBlobUrls(stored)).toBe(stored);
    expect(getSignedBlobUrlMock).not.toHaveBeenCalled();
  });

  it("keeps the stored URL when re-signing fails", async () => {
    getSignedBlobUrlMock.mockRejectedValue(new Error("gone"));
    const stored = { file: handle };
    const refreshed = (await refreshBlobUrls(stored)) as typeof stored;
    expect(refreshed.file.url).toBe(handle.url);
  });
});
