import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture logger.error so we can assert the compatibility failure is reported
// (the logger routes to console + Sentry; here we only need the call).
const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { error: errorMock, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Stub the network fetch used by the pdf -> text path so tests stay hermetic.
const { fetchResumeTextMock, fetchBytesMock } = vi.hoisted(() => ({
  fetchResumeTextMock: vi.fn(),
  fetchBytesMock: vi.fn(),
}));
vi.mock("@/lib/resume-fetch", () => ({
  fetchResumeText: fetchResumeTextMock,
  fetchBytes: fetchBytesMock,
  isDriveSource: () => false,
}));

// Binary path: stub the provider transcode + blob storage so the executor's
// wiring (source selection, two-step job/store split, handle threading) is what's
// under test.
const {
  createMediaJobMock,
  fetchMediaResultMock,
  putBlobMock,
  isBlobConfiguredMock,
} = vi.hoisted(() => ({
  createMediaJobMock: vi.fn(),
  fetchMediaResultMock: vi.fn(),
  putBlobMock: vi.fn(),
  isBlobConfiguredMock: vi.fn(() => true),
}));
vi.mock("@/lib/media-convert", () => ({
  createMediaJob: createMediaJobMock,
  fetchMediaResult: fetchMediaResultMock,
}));
vi.mock("@/lib/blob", () => ({
  isBlobConfigured: isBlobConfiguredMock,
  putBlob: putBlobMock,
}));

// Make `.status(payload)` return the payload so `publish` receives it verbatim,
// decoupling the test from the realtime message envelope.
vi.mock("@/inngest/channels/convert", () => ({
  convertChannel: () => ({ status: (payload: unknown) => payload }),
}));

import type { NodeExecutorParams } from "@/features/executions/types";
import { convertExecutor } from "./executor";

const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
} as unknown as NodeExecutorParams["step"];

let publishedStatuses: string[];
const publish = (async (msg: { status: string }) => {
  publishedStatuses.push(msg.status);
}) as unknown as NodeExecutorParams["publish"];

type ConvertResult = Record<
  string,
  {
    result: unknown;
    from: string;
    to: string;
    file?: { url: string; contentType: string };
  }
>;

const run = (
  data: Record<string, unknown>,
  context: Record<string, unknown> = {},
) =>
  convertExecutor({
    data,
    nodeId: "c1",
    outputKey: "CONVERT_1",
    userId: "u1",
    context,
    step,
    publish,
  }) as Promise<ConvertResult>;

beforeEach(() => {
  errorMock.mockReset();
  fetchResumeTextMock.mockReset();
  fetchBytesMock.mockReset();
  createMediaJobMock.mockReset();
  fetchMediaResultMock.mockReset();
  putBlobMock.mockReset();
  isBlobConfiguredMock.mockReset();
  isBlobConfiguredMock.mockReturnValue(true);
  vi.stubEnv("CLOUDCONVERT_API_KEY", "cc-key");
  publishedStatuses = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("convertExecutor", () => {
  it("runs a sync (from,to) conversion, auto-detecting the source", async () => {
    const result = await run({
      to: "json",
      input: "name,email\nAda,ada@x.com",
    });

    expect(result.CONVERT_1).toEqual({
      result: [{ name: "Ada", email: "ada@x.com" }],
      from: "csv",
      to: "json",
    });
    expect(publishedStatuses).toEqual(["loading", "success"]);
  });

  it("honors a pinned source format", async () => {
    const result = await run({
      to: "csv",
      from: "json",
      input: '[{"a":1,"b":2}]',
    });

    expect(result.CONVERT_1).toMatchObject({ from: "json", to: "csv" });
    expect(result.CONVERT_1.result).toBe("a,b\n1,2");
  });

  it("templates the input against upstream context", async () => {
    const result = await run(
      { to: "html", input: "# @<title>@" },
      { title: "Hello" },
    );

    expect(result.CONVERT_1.to).toBe("html");
    expect(String(result.CONVERT_1.result)).toContain("Hello");
  });

  it("uses the async fetch path for pdf -> text", async () => {
    fetchResumeTextMock.mockResolvedValue({ text: "extracted", kind: "pdf" });

    const result = await run({
      to: "text",
      input: "https://example.com/resume.pdf",
    });

    expect(fetchResumeTextMock).toHaveBeenCalledTimes(1);
    expect(result.CONVERT_1).toEqual({
      result: "extracted",
      from: "pdf",
      to: "text",
    });
  });

  it("normalizes a legacy `conversion` value", async () => {
    const result = await run({
      conversion: "csv_to_json",
      input: "a,b\n1,2",
    });

    expect(result.CONVERT_1).toMatchObject({ from: "csv", to: "json" });
  });

  it("raises the compatibility error (log + throw) for an unsupported pair", async () => {
    // Plain sentence auto-detects as `text`; text -> json is unsupported.
    await expect(run({ to: "json", input: "just a sentence" })).rejects.toThrow(
      "Compatibility Issue - The input is not expected",
    );

    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0][0]).toBe(
      "Compatibility Issue - The input is not expected",
    );
    expect(publishedStatuses).toEqual(["loading", "error"]);
  });

  it("throws when no target format is configured", async () => {
    await expect(run({ input: "a,b\n1,2" })).rejects.toThrow(
      /target format is required/i,
    );
  });

  it("runs a binary conversion: creates a job, stores the blob, threads the handle", async () => {
    createMediaJobMock.mockResolvedValue({ jobId: "job-1" });
    fetchMediaResultMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2]),
      contentType: "image/png",
    });
    putBlobMock.mockResolvedValue({
      key: "conversions/u1/x.png",
      url: "https://cdn/x.png",
      contentType: "image/png",
      byteLength: 2,
    });

    const result = await run({
      to: "png",
      from: "jpg",
      input: "https://example.com/a.jpg",
    });

    // Step A: a pinned source is confident, so its format IS sent as the hint.
    expect(createMediaJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "jpg",
        to: "png",
        source: { url: "https://example.com/a.jpg" },
      }),
    );
    // Step B: poll+download run against the job id from step A, then stored once.
    expect(fetchMediaResultMock).toHaveBeenCalledWith("job-1", "png");
    expect(putBlobMock).toHaveBeenCalledTimes(1);
    expect(result.CONVERT_1).toMatchObject({
      from: "jpg",
      to: "png",
      result: "https://cdn/x.png",
      file: { url: "https://cdn/x.png", contentType: "image/png" },
    });
    expect(publishedStatuses).toEqual(["loading", "success"]);
  });

  it("omits the input_format hint when the binary source is only auto-detected", async () => {
    createMediaJobMock.mockResolvedValue({ jobId: "job-2" });
    fetchMediaResultMock.mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: "image/png",
    });
    putBlobMock.mockResolvedValue({
      key: "conversions/u1/y.png",
      url: "https://cdn/y.png",
      contentType: "image/png",
      byteLength: 1,
    });

    // Extension-less URL, no pinned source → detection falls back to `pdf`
    // (unconfident), so `from` is dropped and the provider infers the format.
    await run({ to: "png", input: "https://example.com/mystery" });

    expect(createMediaJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: undefined,
        to: "png",
        source: { url: "https://example.com/mystery" },
      }),
    );
  });

  it("fails (non-retriably) when CLOUDCONVERT_API_KEY is missing", async () => {
    vi.stubEnv("CLOUDCONVERT_API_KEY", "");

    await expect(
      run({ to: "png", from: "jpg", input: "https://x/a.jpg" }),
    ).rejects.toThrow(/CLOUDCONVERT_API_KEY is not set/);

    expect(createMediaJobMock).not.toHaveBeenCalled();
    expect(publishedStatuses).toEqual(["loading", "error"]);
  });

  it("fails when blob storage is not configured", async () => {
    isBlobConfiguredMock.mockReturnValue(false);

    await expect(
      run({ to: "png", from: "jpg", input: "https://x/a.jpg" }),
    ).rejects.toThrow(/blob storage \(R2\) is not configured/);

    expect(createMediaJobMock).not.toHaveBeenCalled();
  });
});
