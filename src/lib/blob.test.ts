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
  ListObjectsV2Command: class {
    kind = "list";
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  DeleteObjectsCommand: class {
    kind = "deleteMany";
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  DeleteObjectCommand: class {
    kind = "deleteOne";
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

/** Stands in for the SDK's streaming body, which only exposes async readers. */
const responseBody = (text: string) => ({
  transformToByteArray: async () => new TextEncoder().encode(text),
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

import {
  deleteBlob,
  deleteBlobsByPrefix,
  getBlobBytes,
  getBlobJson,
  getSignedBlobUrl,
  isBlobConfigured,
  putBlob,
} from "./blob";

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

  it("is false for a value copied straight from .env.example", () => {
    // Regression: placeholders are non-empty, so a bare truthiness check passed
    // them and the endpoint became
    // `https://your-cloudflare-account-id.r2.cloudflarestorage.com`, which
    // Cloudflare has no certificate for — surfacing as an opaque
    // `SSL alert number 40` that named no host.
    vi.stubEnv("R2_ACCOUNT_ID", "your-cloudflare-account-id");
    expect(isBlobConfigured()).toBe(false);
  });

  it("catches a placeholder in any of the four vars, and tolerates whitespace", () => {
    for (const key of [
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
    ]) {
      vi.stubEnv(key, "  your-r2-thing  ");
      expect(isBlobConfigured()).toBe(false);
      vi.stubEnv(key, CONFIGURED_ENV[key]);
    }
  });

  it("does not reject a real credential that merely contains 'your'", () => {
    vi.stubEnv("R2_BUCKET", "yourcompany-prod-assets");
    expect(isBlobConfigured()).toBe(true);
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

  it("uses an explicit key verbatim when provided", async () => {
    const handle = await putBlob({
      bytes: new Uint8Array([1, 2]),
      contentType: "application/json",
      key: "replay-contexts/exec1/node1.json",
    });

    expect(handle.key).toBe("replay-contexts/exec1/node1.json");
    const sent = sendMock.mock.calls[0][0] as {
      input: Record<string, unknown>;
    };
    expect(sent.input).toMatchObject({
      Key: "replay-contexts/exec1/node1.json",
      ContentType: "application/json",
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

describe("getBlobJson", () => {
  it("downloads and parses the object body", async () => {
    sendMock.mockResolvedValueOnce({ Body: responseBody('{"a":1}') });
    await expect(getBlobJson("replay-contexts/e1/n1.json")).resolves.toEqual({
      a: 1,
    });

    const sent = sendMock.mock.calls[0][0] as {
      kind: string;
      input: Record<string, unknown>;
    };
    expect(sent.kind).toBe("get");
    expect(sent.input).toMatchObject({ Key: "replay-contexts/e1/n1.json" });
  });

  it("throws when the object has no body", async () => {
    sendMock.mockResolvedValueOnce({});
    await expect(getBlobJson("missing.json")).rejects.toThrow(/no body/);
  });
});

describe("getBlobBytes", () => {
  it("returns the raw bytes alongside the stored content type", async () => {
    sendMock.mockResolvedValueOnce({
      Body: responseBody("PNGDATA"),
      ContentType: "image/png",
    });

    const result = await getBlobBytes("avatars/u1/abc.png");

    expect(new TextDecoder().decode(result.bytes)).toBe("PNGDATA");
    expect(result.contentType).toBe("image/png");
  });

  it("falls back to a generic content type when the object has none", async () => {
    sendMock.mockResolvedValueOnce({ Body: responseBody("x") });
    await expect(getBlobBytes("avatars/u1/abc.png")).resolves.toMatchObject({
      contentType: "application/octet-stream",
    });
  });
});

describe("deleteBlob", () => {
  it("deletes exactly the one key it was given", async () => {
    sendMock.mockResolvedValueOnce({});

    await deleteBlob("avatars/u1/old.webp");

    const sent = sendMock.mock.calls[0][0] as {
      kind: string;
      input: Record<string, unknown>;
    };
    expect(sent.kind).toBe("deleteOne");
    expect(sent.input).toMatchObject({
      Bucket: "guideboard-blobs",
      Key: "avatars/u1/old.webp",
    });
  });
});

describe("deleteBlobsByPrefix", () => {
  it("lists pages and batch-deletes every key under the prefix", async () => {
    sendMock
      // Page 1: two keys, truncated.
      .mockResolvedValueOnce({
        Contents: [
          { Key: "conversions/u1/e1/a.jpg" },
          { Key: "conversions/u1/e1/b.pdf" },
        ],
        IsTruncated: true,
        NextContinuationToken: "tok2",
      })
      // Its delete.
      .mockResolvedValueOnce({})
      // Page 2: one key, final.
      .mockResolvedValueOnce({
        Contents: [{ Key: "conversions/u1/e1/c.mp3" }],
        IsTruncated: false,
      })
      // Its delete.
      .mockResolvedValueOnce({});

    const deleted = await deleteBlobsByPrefix("conversions/u1/e1/");
    expect(deleted).toBe(3);

    const kinds = sendMock.mock.calls.map(
      (c) => (c[0] as { kind: string }).kind,
    );
    expect(kinds).toEqual(["list", "deleteMany", "list", "deleteMany"]);

    const secondList = sendMock.mock.calls[2][0] as {
      input: Record<string, unknown>;
    };
    expect(secondList.input).toMatchObject({ ContinuationToken: "tok2" });

    const firstDelete = sendMock.mock.calls[1][0] as {
      input: { Delete: { Objects: Array<{ Key: string }> } };
    };
    expect(firstDelete.input.Delete.Objects).toEqual([
      { Key: "conversions/u1/e1/a.jpg" },
      { Key: "conversions/u1/e1/b.pdf" },
    ]);
  });

  it("skips the delete call when the prefix matches nothing", async () => {
    sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    await expect(deleteBlobsByPrefix("conversions/none/")).resolves.toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
