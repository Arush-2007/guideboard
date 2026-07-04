import "server-only";
import { getSignedBlobUrl, isBlobConfigured } from "@/lib/blob";

/**
 * Re-signs expired blob URLs in persisted execution data at read time.
 *
 * When `R2_PUBLIC_BASE_URL` is unset, `putBlob` returns a 1-hour signed URL,
 * and that URL gets frozen into `NodeExecution.input/output` and
 * `Execution.output`. Anyone viewing the run later than that sees dead links.
 * The stored `BlobHandle` keeps the object `key` alongside the `url`, so the
 * fix is read-side only: walk the value, mint a fresh signed URL per handle,
 * and also replace any *string copy* of the stale URL (e.g. the Convert
 * node's `result` field duplicates `file.url`).
 *
 * No-ops when a public base URL is configured (those URLs never expire) or
 * when R2 is off entirely.
 */

/** Key prefixes owned by `putBlob` — anything else with a `key` field isn't ours. */
const BLOB_KEY_PREFIXES = ["conversions/", "replay-contexts/"];

type BlobHandleLike = { key: string; url: string };

function isBlobHandleLike(value: unknown): value is BlobHandleLike {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    typeof v.url === "string" &&
    BLOB_KEY_PREFIXES.some((p) => (v.key as string).startsWith(p))
  );
}

function collectHandles(value: unknown, found: Map<string, string>): void {
  if (typeof value !== "object" || value === null) return;
  if (isBlobHandleLike(value)) {
    // key -> stale url (first sighting wins; all copies of a key share a url)
    if (!found.has(value.key)) found.set(value.key, value.url);
  }
  for (const child of Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>)) {
    collectHandles(child, found);
  }
}

function rewrite(value: unknown, urlByStale: Map<string, string>): unknown {
  if (typeof value === "string") {
    return urlByStale.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewrite(v, urlByStale));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewrite(v, urlByStale);
    }
    return out;
  }
  return value;
}

export async function refreshBlobUrls(value: unknown): Promise<unknown> {
  // Public URLs never expire; nothing to refresh. Without R2 config we can't
  // sign at all — return the data untouched rather than failing the read.
  if (process.env.R2_PUBLIC_BASE_URL || !isBlobConfigured()) {
    return value;
  }

  const staleByKey = new Map<string, string>();
  collectHandles(value, staleByKey);
  if (staleByKey.size === 0) return value;

  // stale url -> fresh url; string-level replacement catches both the handles
  // themselves and any plain-string copies of the same link.
  const urlByStale = new Map<string, string>();
  for (const [key, staleUrl] of staleByKey) {
    try {
      urlByStale.set(staleUrl, await getSignedBlobUrl(key));
    } catch {
      // Signing failed (deleted object, transient R2 error) — leave that URL
      // as stored; a read helper must never break the execution view.
    }
  }
  if (urlByStale.size === 0) return value;

  return rewrite(value, urlByStale);
}
