/**
 * The rules and key conventions for stored avatars, in one place so the upload
 * route and the proxy route can't drift apart.
 *
 * Avatars live in the same private R2 bucket as everything else and are served
 * back through `/api/profile/avatar/<userId>/<file>` rather than a presigned
 * URL: a presigned URL expires, and an expired URL inside an `<img src>` is a
 * broken face. The proxy keeps the bucket private and lets the response carry
 * an immutable cache header instead — object keys are content-addressed
 * (cuid2), so a new upload is a new URL and a cached one is never stale.
 */

/** Post-resize cap. The browser resizes to 512x512 first, so this is slack. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** The formats a browser canvas can emit, and the extension each is stored as. */
const EXTENSION_BY_CONTENT_TYPE = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
} as const;

export type AvatarContentType = keyof typeof EXTENSION_BY_CONTENT_TYPE;

export const avatarExtension = (contentType: AvatarContentType): string =>
  EXTENSION_BY_CONTENT_TYPE[contentType];

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((byte, i) => bytes[offset + i] === byte);

/**
 * Identifies an image from its leading bytes. The declared `Content-Type` on an
 * upload is attacker-controlled, so the stored type is decided here instead —
 * otherwise an HTML or SVG payload could be stored and later served from our
 * own origin with whatever type the uploader claimed.
 */
export function sniffAvatarContentType(
  bytes: Uint8Array,
): AvatarContentType | null {
  if (bytes.length < 12) return null;

  // PNG signature.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // JPEG SOI + marker.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // RIFF container tagged WEBP.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Only the exact shape this app writes. The proxy route interpolates the
 * filename into an object key, so anything else — a slash, a `..`, an unknown
 * extension — is rejected before it can reach the bucket.
 */
const AVATAR_FILE_RE = /^[a-z0-9]{8,40}\.(?:webp|png|jpg)$/;

export const isValidAvatarFile = (file: string): boolean =>
  AVATAR_FILE_RE.test(file);

export const avatarObjectKey = (userId: string, file: string): string =>
  `avatars/${userId}/${file}`;

export const avatarPublicPath = (userId: string, file: string): string =>
  `/api/profile/avatar/${userId}/${file}`;

/**
 * Recovers `{ userId, file }` from a stored `User.image`, so a replacement can
 * delete the object it supersedes. Returns null for anything we didn't write —
 * notably the external Google/GitHub avatar URLs, which must be left alone.
 */
export function parseAvatarPath(
  image: string | null | undefined,
): { userId: string; file: string } | null {
  if (!image) return null;

  const match = /^\/api\/profile\/avatar\/([^/]+)\/([^/]+)$/.exec(image);
  if (!match) return null;

  const [, userId, file] = match;
  if (!isValidAvatarFile(file)) return null;

  return { userId, file };
}
