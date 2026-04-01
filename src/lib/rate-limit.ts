const store = new Map<string, number[]>();

/**
 * In-memory sliding-window rate limiter.
 * Returns true if the request is allowed, false if it exceeds the limit.
 */
export function isAllowed(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const timestamps = (store.get(key) ?? []).filter(
    (t) => now - t < windowMs,
  );

  if (timestamps.length >= limit) {
    store.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  store.set(key, timestamps);
  return true;
}
