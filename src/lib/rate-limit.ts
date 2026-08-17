/**
 * In-memory sliding-window rate limiter.
 *
 * ## Why this evicts
 *
 * The store is keyed by whatever the caller passes, and several callers key by
 * something the CALLER OF THE ROUTE controls — a webhook token, a `?workflowId=`
 * on a public endpoint. Without eviction, every distinct value ever seen is a
 * permanent entry: an anonymous flood of random tokens grows this Map until the
 * process dies, and the limiter meant to bound abuse becomes the abuse vector.
 *
 * A key is dead once its whole window has elapsed with no traffic. The main path
 * reclaims a key it happens to touch, but the dangerous keys are exactly the ones
 * never touched again — so a periodic sweep walks the Map and drops what expired.
 * The sweep is O(entries) but runs at most once per SWEEP_INTERVAL_MS, so it is
 * amortized to roughly nothing per request while bounding live entries to "keys
 * seen in the last window, plus at most one sweep interval of garbage".
 *
 * Still per-process and therefore per-instance: N instances behind a load
 * balancer allow N times the limit. That is a deliberate floor, not a ceiling —
 * it exists to stop a single host being trivially swamped, and anything needing a
 * true global limit wants a shared store (Redis) rather than this.
 */

type Bucket = {
  /** Request times inside the window, oldest first. */
  timestamps: number[];
  /** Kept per key so the sweep knows when this bucket is dead. */
  windowMs: number;
};

const store = new Map<string, Bucket>();

const SWEEP_INTERVAL_MS = 60_000;
let nextSweepAt = 0;

/** Drop every bucket whose newest request is older than its own window. */
function sweep(now: number): void {
  for (const [key, bucket] of store) {
    const newest = bucket.timestamps[bucket.timestamps.length - 1];
    if (newest === undefined || now - newest >= bucket.windowMs) {
      store.delete(key);
    }
  }
}

/**
 * Returns true if the request is allowed, false if it exceeds the limit.
 *
 * Keying by a value the caller controls is fine — eviction is what makes it
 * safe — but note that each distinct key gets its own independent budget, so a
 * key an attacker can vary is not a limit on the total.
 */
export function isAllowed(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();

  if (now >= nextSweepAt) {
    sweep(now);
    nextSweepAt = now + SWEEP_INTERVAL_MS;
  }

  const timestamps = (store.get(key)?.timestamps ?? []).filter(
    (t) => now - t < windowMs,
  );

  if (timestamps.length >= limit) {
    store.set(key, { timestamps, windowMs });
    return false;
  }

  timestamps.push(now);
  store.set(key, { timestamps, windowMs });
  return true;
}

/** Live key count. Exported for tests to assert eviction actually happens. */
export function __rateLimitKeyCount(): number {
  return store.size;
}
