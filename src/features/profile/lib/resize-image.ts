/**
 * Browser-side avatar normalisation: whatever the user picks becomes a square
 * 512x512 image of roughly 50 KB before it ever leaves the page.
 *
 * Doing this here rather than on the server keeps `sharp` (a native binary, and
 * real build weight on Vercel) out of the dependency tree. The server still
 * enforces the size cap and sniffs the real format, so a client that skips this
 * step gains nothing — it only means a bigger upload that may be rejected.
 */

/** Stored avatars are square; this is 2x a 256px display at retina density. */
export const AVATAR_DIMENSION = 512;

const QUALITY = 0.85;

/**
 * Centre-crop geometry for fitting any aspect ratio into a square: take the
 * largest centred square the source contains, so a wide photo loses its sides
 * rather than being squashed. Pure arithmetic, kept separate so it's testable
 * without a DOM.
 */
export function centerCropRect(
  width: number,
  height: number,
): { x: number; y: number; size: number } {
  const size = Math.min(width, height);
  return {
    x: Math.round((width - size) / 2),
    y: Math.round((height - size) / 2),
    size,
  };
}

const loadImage = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file couldn't be read as an image."));
    };
    image.src = url;
  });

const toBlob = (
  canvas: HTMLCanvasElement,
  type: string,
): Promise<Blob | null> =>
  new Promise((resolve) => {
    canvas.toBlob(resolve, type, QUALITY);
  });

/**
 * Reads `file`, centre-crops it to a square, scales it to `AVATAR_DIMENSION`,
 * and re-encodes it. WebP first for the size win; canvases that don't support
 * it silently hand back a PNG, which `toBlob`'s `type` echo lets us detect, so
 * we fall back to JPEG explicitly rather than shipping a 400 KB PNG.
 */
export async function resizeAvatar(file: File): Promise<Blob> {
  const image = await loadImage(file);

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_DIMENSION;
  canvas.height = AVATAR_DIMENSION;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Your browser couldn't process that image.");
  }

  const { x, y, size } = centerCropRect(
    image.naturalWidth,
    image.naturalHeight,
  );
  ctx.drawImage(
    image,
    x,
    y,
    size,
    size,
    0,
    0,
    AVATAR_DIMENSION,
    AVATAR_DIMENSION,
  );

  const webp = await toBlob(canvas, "image/webp");
  if (webp?.type === "image/webp") {
    return webp;
  }

  const jpeg = await toBlob(canvas, "image/jpeg");
  if (!jpeg) {
    throw new Error("Your browser couldn't process that image.");
  }
  return jpeg;
}
