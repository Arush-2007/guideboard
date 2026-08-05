import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  convertMedia,
  createMediaJob,
  fetchMediaResult,
  isMediaConvertConfigured,
} from "./media-convert";

const fetchMock = vi.fn();

const jsonResponse = (data: unknown, ok = true, status = 200) => ({
  ok,
  status,
  statusText: ok ? "OK" : "Error",
  headers: new Headers(),
  json: async () => data,
  arrayBuffer: async () => new ArrayBuffer(0),
});

const bytesResponse = (
  bytes: Uint8Array,
  headers: Record<string, string> = {},
) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: new Headers(headers),
  json: async () => ({}),
  arrayBuffer: async () =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CLOUDCONVERT_API_KEY", "cc-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("isMediaConvertConfigured", () => {
  it("reflects whether the provider key is set", () => {
    expect(isMediaConvertConfigured()).toBe(true);
    vi.stubEnv("CLOUDCONVERT_API_KEY", "");
    expect(isMediaConvertConfigured()).toBe(false);
  });

  it("treats the unedited .env.example placeholder as not configured", () => {
    // Non-empty, so a bare truthiness check passed it and a fake key went to
    // the provider instead of the clean "not configured" path.
    vi.stubEnv("CLOUDCONVERT_API_KEY", "your-cloudconvert-api-key");
    expect(isMediaConvertConfigured()).toBe(false);
  });
});

describe("convertMedia (URL source)", () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/jobs") && init?.method === "POST") {
        return jsonResponse({
          data: {
            id: "job1",
            status: "waiting",
            tasks: [
              {
                id: "t1",
                name: "import-file",
                operation: "import/url",
                status: "waiting",
              },
            ],
          },
        });
      }
      if (url.endsWith("/jobs/job1")) {
        return jsonResponse({
          data: {
            id: "job1",
            status: "finished",
            tasks: [
              {
                id: "t3",
                name: "export-file",
                operation: "export/url",
                status: "finished",
                result: {
                  files: [
                    { filename: "out.png", url: "https://files.cc/out.png" },
                  ],
                },
              },
            ],
          },
        });
      }
      if (url === "https://files.cc/out.png") {
        return bytesResponse(new Uint8Array([9, 8, 7]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  it("builds the job, downloads the output, and returns bytes + content type", async () => {
    const result = await convertMedia({
      from: "jpg",
      to: "png",
      source: { url: "https://example.com/a.jpg" },
    });

    expect(Array.from(result.bytes)).toEqual([9, 8, 7]);
    expect(result.contentType).toBe("image/png");

    // The convert + import tasks carried the right formats + source.
    const post = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith("/jobs") && c[1]?.method === "POST",
    );
    const body = JSON.parse((post?.[1] as RequestInit).body as string);
    expect(body.tasks["convert-file"]).toMatchObject({
      input_format: "jpg",
      output_format: "png",
    });
    expect(body.tasks["import-file"]).toMatchObject({
      operation: "import/url",
      url: "https://example.com/a.jpg",
    });
    // Authorized with the provider key.
    expect((post?.[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer cc-key",
    });
  });

  it("omits input_format when the source format is not provided (provider infers)", async () => {
    await convertMedia({
      to: "png",
      source: { url: "https://example.com/mystery" },
    });

    const post = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith("/jobs") && c[1]?.method === "POST",
    );
    const body = JSON.parse((post?.[1] as RequestInit).body as string);
    expect(body.tasks["convert-file"]).toMatchObject({ output_format: "png" });
    expect(body.tasks["convert-file"]).not.toHaveProperty("input_format");
  });

  it("createMediaJob returns just the job id; fetchMediaResult polls + downloads it", async () => {
    const { jobId } = await createMediaJob({
      from: "jpg",
      to: "png",
      source: { url: "https://example.com/a.jpg" },
    });
    expect(jobId).toBe("job1");

    const result = await fetchMediaResult(jobId, "png");
    expect(Array.from(result.bytes)).toEqual([9, 8, 7]);
    expect(result.contentType).toBe("image/png");
  });

  it("rejects an oversized output via Content-Length before buffering", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/jobs/job1")) {
        return jsonResponse({
          data: {
            id: "job1",
            status: "finished",
            tasks: [
              {
                id: "t3",
                name: "export-file",
                operation: "export/url",
                status: "finished",
                result: {
                  files: [
                    { filename: "out.mp4", url: "https://files.cc/out.mp4" },
                  ],
                },
              },
            ],
          },
        });
      }
      if (url === "https://files.cc/out.mp4") {
        return bytesResponse(new Uint8Array(0), {
          "content-length": String(200 * 1024 * 1024),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(fetchMediaResult("job1", "mp4")).rejects.toThrow(
      /too large to process/,
    );
  });

  it("rejects an oversized output body when the header was absent", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/jobs/job1")) {
        return jsonResponse({
          data: {
            id: "job1",
            status: "finished",
            tasks: [
              {
                id: "t3",
                name: "export-file",
                operation: "export/url",
                status: "finished",
                result: {
                  files: [
                    { filename: "out.mp4", url: "https://files.cc/out.mp4" },
                  ],
                },
              },
            ],
          },
        });
      }
      if (url === "https://files.cc/out.mp4") {
        return bytesResponse(new Uint8Array(51 * 1024 * 1024));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(fetchMediaResult("job1", "mp4")).rejects.toThrow(
      /too large to process/,
    );
  });
});

describe("convertMedia (bytes source uploads to the provider)", () => {
  it("posts the bytes to the import form before polling", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/jobs") && init?.method === "POST") {
        return jsonResponse({
          data: {
            id: "job2",
            status: "waiting",
            tasks: [
              {
                id: "u1",
                name: "import-file",
                operation: "import/upload",
                status: "waiting",
                result: {
                  form: {
                    url: "https://upload.cc/put",
                    parameters: { key: "abc" },
                  },
                },
              },
            ],
          },
        });
      }
      if (url === "https://upload.cc/put") {
        return jsonResponse({}, true, 201);
      }
      if (url.endsWith("/jobs/job2")) {
        return jsonResponse({
          data: {
            id: "job2",
            status: "finished",
            tasks: [
              {
                id: "e1",
                name: "export-file",
                operation: "export/url",
                status: "finished",
                result: {
                  files: [{ filename: "o.pdf", url: "https://files.cc/o.pdf" }],
                },
              },
            ],
          },
        });
      }
      if (url === "https://files.cc/o.pdf")
        return bytesResponse(new Uint8Array([1]));
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await convertMedia({
      from: "png",
      to: "pdf",
      source: { bytes: new Uint8Array([5, 5]), filename: "input.png" },
    });

    expect(result.contentType).toBe("application/pdf");
    const uploadCall = fetchMock.mock.calls.find(
      (c) => c[0] === "https://upload.cc/put",
    );
    expect(uploadCall).toBeDefined();
    expect((uploadCall?.[1] as RequestInit).body).toBeInstanceOf(FormData);
  });
});

describe("convertMedia errors", () => {
  it("throws when the provider key is missing (before any request)", async () => {
    vi.stubEnv("CLOUDCONVERT_API_KEY", "");
    await expect(
      convertMedia({
        from: "jpg",
        to: "png",
        source: { url: "https://x/a.jpg" },
      }),
    ).rejects.toThrow(/CloudConvert is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the job reports an error status", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/jobs") && init?.method === "POST") {
        return jsonResponse({
          data: { id: "job3", status: "waiting", tasks: [] },
        });
      }
      if (url.endsWith("/jobs/job3")) {
        return jsonResponse({
          data: {
            id: "job3",
            status: "error",
            tasks: [
              {
                id: "c1",
                name: "convert-file",
                operation: "convert",
                status: "error",
                message: "unsupported codec",
              },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(
      convertMedia({
        from: "mp4",
        to: "mp3",
        source: { url: "https://x/a.mp4" },
      }),
    ).rejects.toThrow(/job failed: unsupported codec/);
  });
});
