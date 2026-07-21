import { createId } from "@paralleldrive/cuid2";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import {
  AVATAR_MAX_BYTES,
  avatarExtension,
  avatarObjectKey,
  avatarPublicPath,
  parseAvatarPath,
  sniffAvatarContentType,
} from "@/features/profile/lib/avatar-storage";
import { auth } from "@/lib/auth";
import { deleteBlob, isBlobConfigured, putBlob } from "@/lib/blob";
import prisma from "@/lib/db";
import { isAllowed } from "@/lib/rate-limit";

/**
 * Avatar upload and removal.
 *
 * A route handler rather than a tRPC mutation because this carries binary: a
 * superjson-encoded base64 payload would inflate the bytes by a third for no
 * gain. Reads of the stored object happen in the sibling
 * `[userId]/[file]` route.
 */

/** Uploads are cheap but not free; enough headroom to fiddle, not to abuse. */
const UPLOADS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

const badRequest = (message: string, status = 400) =>
  NextResponse.json({ error: message }, { status });

/**
 * Drops the object a `User.image` points at, when we're the ones who wrote it —
 * an external Google/GitHub avatar URL parses to null and is left alone. The
 * owner check is belt-and-braces: the key is only ever built from the signed-in
 * user's own row, and a delete must never be steerable by a stored value.
 */
async function deleteExistingAvatar(image: string | null, userId: string) {
  const previous = parseAvatarPath(image);
  if (!previous || previous.userId !== userId) return;
  try {
    await deleteBlob(avatarObjectKey(previous.userId, previous.file));
  } catch {
    // A leftover object is harmless — never fail the user's action over it.
  }
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return badRequest("Unauthorized", 401);
  }
  const userId = session.user.id;

  if (!isBlobConfigured()) {
    return badRequest(
      "Avatar uploads aren't available — object storage isn't configured.",
      503,
    );
  }

  if (!isAllowed(`avatar-upload:${userId}`, UPLOADS_PER_HOUR, HOUR_MS)) {
    return badRequest(
      "Too many avatar changes in the last hour. Try again later.",
      429,
    );
  }

  let file: unknown;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return badRequest("Expected a multipart form upload.");
  }

  if (!(file instanceof File)) {
    return badRequest("No file was uploaded.");
  }
  // Cheap pre-check on the declared size before buffering the body.
  if (file.size > AVATAR_MAX_BYTES) {
    return badRequest("That image is too large — the limit is 2 MB.", 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Re-check post-buffer: `File.size` is client-supplied and can lie.
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    return badRequest("That image is too large — the limit is 2 MB.", 413);
  }

  // The stored type comes from the bytes, never from the declared one.
  const contentType = sniffAvatarContentType(bytes);
  if (!contentType) {
    return badRequest("That file isn't a PNG, JPEG, or WebP image.");
  }

  // Read the outgoing image before overwriting it. `session.user.image` can't
  // be used here — the session is served from a 5-minute cookie cache, so it
  // may still name an avatar that was already replaced.
  const { image: previousImage } = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { image: true },
  });

  const name = `${createId()}.${avatarExtension(contentType)}`;
  await putBlob({ key: avatarObjectKey(userId, name), bytes, contentType });

  const image = avatarPublicPath(userId, name);
  await prisma.user.update({ where: { id: userId }, data: { image } });
  // Only once the new avatar is durably referenced, so a failure mid-way leaves
  // the old face working rather than none at all.
  await deleteExistingAvatar(previousImage, userId);

  return NextResponse.json({ image });
}

export async function DELETE() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return badRequest("Unauthorized", 401);
  }

  const { image } = await prisma.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { image: true },
  });

  await prisma.user.update({
    where: { id: session.user.id },
    data: { image: null },
  });
  await deleteExistingAvatar(image, session.user.id);

  return NextResponse.json({ image: null });
}
