import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_TRANSFER_BYTES } from "./file-limits";
import { fetchBytes, isDriveSource, normalizeResumeUrl } from "./resume-fetch";

const FILE_ID = "1T_ZGII-67IQMZNMUqPmHTse7w3pc_gqx";
const MEDIA = `https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media`;

describe("normalizeResumeUrl", () => {
  it("rewrites a Drive /file/d/ share link to a media URL", () => {
    expect(
      normalizeResumeUrl(`https://drive.google.com/file/d/${FILE_ID}/view`),
    ).toBe(MEDIA);
  });

  it("rewrites a Drive open?id= link to a media URL", () => {
    expect(
      normalizeResumeUrl(`https://drive.google.com/open?id=${FILE_ID}`),
    ).toBe(MEDIA);
  });

  it("unwraps a Google Forms upload array of a bare file ID", () => {
    expect(normalizeResumeUrl(`["${FILE_ID}"]`)).toBe(MEDIA);
  });

  it("rewrites a bare Drive file ID", () => {
    expect(normalizeResumeUrl(FILE_ID)).toBe(MEDIA);
  });

  it("passes a plain http(s) URL through untouched", () => {
    const url = "https://example.com/resume.pdf";
    expect(normalizeResumeUrl(url)).toBe(url);
  });

  it("unwraps an array that already holds a full URL", () => {
    const url = "https://example.com/resume.pdf";
    expect(normalizeResumeUrl(`["${url}"]`)).toBe(url);
  });
});

describe("isDriveSource", () => {
  it("is true for Drive URLs, bare IDs, and upload arrays", () => {
    expect(
      isDriveSource(`https://drive.google.com/file/d/${FILE_ID}/view`),
    ).toBe(true);
    expect(isDriveSource(FILE_ID)).toBe(true);
    expect(isDriveSource(`["${FILE_ID}"]`)).toBe(true);
  });

  it("is false for a plain external URL", () => {
    expect(isDriveSource("https://example.com/resume.pdf")).toBe(false);
  });
});

describe("fetchBytes size guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (response: {
    contentLength?: string;
    body?: Uint8Array;
  }) => {
    const headers = new Headers();
    if (response.contentLength !== undefined) {
      headers.set("content-length", response.contentLength);
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers,
        arrayBuffer: async () =>
          (response.body ?? new Uint8Array([1, 2, 3])).buffer,
      })),
    );
  };

  it("rejects an oversized Content-Length before buffering the body", async () => {
    stubFetch({ contentLength: String(MAX_FILE_TRANSFER_BYTES + 1) });
    await expect(fetchBytes("https://example.com/huge.mp4")).rejects.toThrow(
      /too large to process/,
    );
  });

  it("rejects an oversized body even when the header was absent", async () => {
    stubFetch({ body: new Uint8Array(MAX_FILE_TRANSFER_BYTES + 1) });
    await expect(fetchBytes("https://example.com/huge.pdf")).rejects.toThrow(
      /too large to process/,
    );
  });

  it("returns bytes for a file within the limit", async () => {
    stubFetch({ contentLength: "3", body: new Uint8Array([9, 8, 7]) });
    const { bytes } = await fetchBytes("https://example.com/ok.txt");
    expect(Array.from(bytes)).toEqual([9, 8, 7]);
  });
});
