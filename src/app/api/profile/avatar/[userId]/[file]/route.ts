import { NextResponse } from "next/server";
import {
  avatarObjectKey,
  isValidAvatarFile,
  isValidAvatarUserId,
} from "@/features/profile/lib/avatar-storage";
import { getBlobBytes, isBlobConfigured } from "@/lib/blob";

/**
 * Serves a stored avatar out of the private R2 bucket.
 *
 * Deliberately unauthenticated. An avatar is low-sensitivity, the object key
 * carries a cuid2 nobody can guess, and requiring a session would mean the
 * image couldn't be cached at the edge or rendered anywhere a cookie isn't
 * sent. What this buys in exchange is that the bucket itself stays private —
 * no public bucket, no second bucket, no expiring URL inside an `<img src>`.
 *
 * Keys are content-addressed, so a replaced avatar is a *different* URL and
 * this response can be cached forever without ever going stale.
 */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string; file: string }> },
) {
  const { userId, file } = await params;

  // Both segments are interpolated straight into an object key below, so both
  // have to match the exact shape we write — no traversal, no surprise
  // extensions.
  if (!isValidAvatarUserId(userId) || !isValidAvatarFile(file)) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (!isBlobConfigured()) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const { bytes, contentType } = await getBlobBytes(
      avatarObjectKey(userId, file),
    );

    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": IMMUTABLE_CACHE,
        // The bytes are attacker-supplied in principle; make sure nothing can
        // be coaxed into executing on our own origin.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
