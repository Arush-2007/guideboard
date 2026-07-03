import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the S3 interactions without a real network/credentials.
const { sendMock, getSignedUrlMock, s3ClientCtor } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
  s3ClientCtor: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  // A class so `new S3Client(...)` works; the ctor spy records the config.
  S3Client: class {
    send = sendMock;
    constructor(config: unknown) {
      s3ClientCtor(config);
    }
  },
  // Commands echo their input so we can assert what putBlob sent.
  PutObjectCommand: class {
    kind = "put";
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    kind = "get";
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

import { getSignedBlobUrl, isBlobConfigured, putBlob } from "./blob";

const CONFIGURED_ENV: Record<string, string> = {
  R2_ACCOUNT_ID: "acct-123",
  R2_ACCESS_KEY_ID: "ak",
  R2_SECRET_ACCESS_KEY: "sk",
  R2_BUCKET: "guideboard-blobs",
};

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({});
  getSignedUrlMock.mockReset().mockResolvedValue("https://signed.example/obj");
  s3ClientCtor.mockReset();
  for (const [k, v] of Object.entries(CONFIGURED_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("R2_PUBLIC_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isBlobConfigured", () => {
  it("is true when all required vars are set", () => {
    expect(isBlobConfigured()).toBe(true);
  });

  it("is false when a required var is missing", () => {
    vi.stubEnv("R2_BUCKET", "");
    expect(isBlobConfigured()).toBe(false);
  });
});

describe("putBlob", () => {
  it("uploads under a per-user cuid2 key and returns a handle", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const handle = await putBlob({
      bytes,
      contentType: "image/jpeg",
      userId: "u1",
      ext: "jpg",
    });

    expect(handle.key).toMatch(/^conversions\/u1\/[a-z0-9]+\.jpg$/);
    expect(handle.contentType).toBe("image/jpeg");
    expect(handle.byteLength).toBe(5);

    // The PutObjectCommand carried the bucket, key, body, and content type.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sent = sendMock.mock.calls[0][0] as {
      kind: string;
      input: Record<string, unknown>;
    };
    expect(sent.kind).toBe("put");
    expect(sent.input).toMatchObject({
      Bucket: "guideboard-blobs",
      Key: handle.key,
      Body: bytes,
      ContentType: "image/jpeg",
    });
  });

  it("normalizes the extension (leading dot / uppercase)", async () => {
    const handle = await putBlob({
      bytes: new Uint8Array([0]),
      contentType: "application/pdf",
      userId: "u1",
      ext: ".PDF",
    });
    expect(handle.key.endsWith(".pdf")).toBe(true);
  });

  it("uses the public base URL when configured (no signing)", async () => {
    vi.stubEnv("R2_PUBLIC_BASE_URL", "https://cdn.example.com/");
    const handle = await putBlob({
      bytes: new Uint8Array([0]),
      contentType: "image/png",
      userId: "u2",
      ext: "png",
    });

    expect(handle.url).toBe(`https://cdn.example.com/${handle.key}`);
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it("falls back to a signed URL when no public base URL is set", async () => {
    const handle = await putBlob({
      bytes: new Uint8Array([0]),
      contentType: "image/png",
      userId: "u2",
      ext: "png",
    });

    expect(handle.url).toBe("https://signed.example/obj");
    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when R2 is not configured", async () => {
    vi.stubEnv("R2_BUCKET", "");
    await expect(
      putBlob({
        bytes: new Uint8Array([0]),
        contentType: "text/plain",
        userId: "u1",
        ext: "txt",
      }),
    ).rejects.toThrow(/Blob storage is not configured/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("getSignedBlobUrl", () => {
  it("signs a GET for the key with the requested TTL", async () => {
    const url = await getSignedBlobUrl("conversions/u1/abc.jpg", 120);
    expect(url).toBe("https://signed.example/obj");

    const [, command, opts] = getSignedUrlMock.mock.calls[0];
    expect(
      (command as { kind: string; input: Record<string, unknown> }).kind,
    ).toBe("get");
    expect(
      (command as { kind: string; input: Record<string, unknown> }).input,
    ).toMatchObject({
      Bucket: "guideboard-blobs",
      Key: "conversions/u1/abc.jpg",
    });
    expect(opts).toEqual({ expiresIn: 120 });
  });

  it("defaults the TTL to one hour", async () => {
    await getSignedBlobUrl("conversions/u1/abc.jpg");
    const [, , opts] = getSignedUrlMock.mock.calls[0];
    expect(opts).toEqual({ expiresIn: 3600 });
  });
});
