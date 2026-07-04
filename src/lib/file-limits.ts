/**
 * Shared cap on file downloads that get buffered whole into memory (resume
 * fetches, CloudConvert output downloads). These run inside serverless/Inngest
 * workers with bounded memory, so an unbounded `arrayBuffer()` on a large
 * video/PDF can OOM the executor. Checked twice per download: against the
 * `Content-Length` header before buffering (cheap early exit), and against the
 * actual byte length after (the header can lie or be absent).
 */

export const MAX_FILE_TRANSFER_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * A user-fixable "your file is too big" failure. Executors map this to
 * `NonRetriableError` — retrying won't shrink the file.
 */
export class FileTooLargeError extends Error {
  constructor(bytes: number, source: string) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const limitMb = Math.round(MAX_FILE_TRANSFER_BYTES / (1024 * 1024));
    super(
      `${source} is too large to process (${mb} MB — the limit is ${limitMb} MB).`,
    );
    this.name = "FileTooLargeError";
  }
}

/**
 * Throws `FileTooLargeError` when a known size exceeds the cap. `bytes` may be
 * null/NaN (absent Content-Length) — that's a no-op; the post-buffer check
 * still applies.
 */
export function assertWithinTransferLimit(
  bytes: number | null,
  source: string,
): void {
  if (
    bytes !== null &&
    Number.isFinite(bytes) &&
    bytes > MAX_FILE_TRANSFER_BYTES
  ) {
    throw new FileTooLargeError(bytes, source);
  }
}
