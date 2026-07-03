import "server-only";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createId } from "@paralleldrive/cuid2";

/**
 * Blob storage primitive, backed by Cloudflare R2 (S3-compatible API). Binary
 * node outputs (converted images, PDFs, audio/video) must NOT travel through the
 * workflow `context` as base64 — that bloats every Inngest step's state (there
 * are step-output size limits), the `Execution` row, and memory. Instead a node
 * writes the bytes here and threads a small `BlobHandle` (a URL + metadata) so
 * downstream nodes reference the file, not its contents.
 *
 * This is the single home for object storage, mirroring the lazy env-checked
 * singleton style of `encryption.ts`/`email.ts`: R2 config is validated on first
 * use (with a clear error), and the S3 client is memoized. R2 speaks the S3 API,
 * so `@aws-sdk/client-s3` is portable to S3/MinIO by swapping the endpoint —
 * nothing else about the shape changes.
 */

/**
 * A reference to a stored object threaded through the workflow `context` in
 * place of the bytes. Emitted by any node that produces binary output, so it's
 * declared once here and imported everywhere (never re-typed per node).
 */
export type BlobHandle = {
  /** Object key within the bucket, e.g. `conversions/<userId>/<id>.jpg`. */
  key: string;
  /** A fetchable URL: the public base URL when set, else a signed URL. */
  url: string;
  contentType: string;
  byteLength: number;
};

type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl?: string;
};

/** Default lifetime for signed GET URLs when no public base URL is configured. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Whether R2 is configured — lets callers degrade gracefully without throwing. */
export const isBlobConfigured = (): boolean =>
  Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  );

/**
 * Reads + validates R2 config on every call (cheap; lets tests toggle env),
 * throwing a clear, actionable error when unset. The client itself is memoized.
 */
function readConfig(): R2Config {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Blob storage is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, " +
        "R2_SECRET_ACCESS_KEY, and R2_BUCKET in your .env.",
    );
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || undefined,
  };
}

let client: S3Client | null = null;

function getClient(config: R2Config): S3Client {
  if (client) return client;
  client = new S3Client({
    // R2 ignores the region but the SDK requires one; "auto" is R2's convention.
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return client;
}

/** Normalizes a user-supplied extension (`".JPG"`, `"jpg"`) to a bare `"jpg"`. */
const normalizeExt = (ext: string): string =>
  ext.replace(/^\.+/, "").toLowerCase();

export type PutBlobArgs = {
  bytes: Uint8Array | Buffer;
  contentType: string;
  /** Scopes the object key per user so blobs are namespaced + easy to prune. */
  userId: string;
  /** File extension (with or without a leading dot) for the object key. */
  ext: string;
};

/**
 * Uploads bytes to R2 and returns a `BlobHandle`. The key is
 * `conversions/<userId>/<cuid2>.<ext>` — collision-free (cuid2) and namespaced
 * per user. Returns the public URL when `R2_PUBLIC_BASE_URL` is set, otherwise a
 * time-limited signed URL.
 */
export async function putBlob({
  bytes,
  contentType,
  userId,
  ext,
}: PutBlobArgs): Promise<BlobHandle> {
  const config = readConfig();
  const s3 = getClient(config);

  const safeExt = normalizeExt(ext);
  const key = `conversions/${userId}/${createId()}${safeExt ? `.${safeExt}` : ""}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
    }),
  );

  const url = config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/+$/, "")}/${key}`
    : await getSignedBlobUrl(key);

  return { key, url, contentType, byteLength: bytes.byteLength };
}

/**
 * Mints a time-limited signed GET URL for a stored object. Used when there's no
 * public base URL, or when a downstream node needs fresh access to a blob.
 */
export async function getSignedBlobUrl(
  key: string,
  ttlSeconds: number = SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  const config = readConfig();
  const s3 = getClient(config);
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: ttlSeconds },
  );
}
