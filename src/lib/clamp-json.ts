/**
 * Bounds the size of a JSON value before it is persisted (per-node input/output
 * snapshots in NodeExecution). The common case — small payloads — is stored
 * verbatim; only oversized values are replaced with a truncation marker so a
 * single huge context can't bloat the executions tables.
 */

export const DEFAULT_CLAMP_BYTES = 32_768;

export interface ClampedMarker {
  __truncated: true;
  bytes: number;
  preview: string;
}

/**
 * Returns `value` unchanged when its JSON serialization fits within `maxBytes`,
 * otherwise a `{ __truncated, bytes, preview }` marker. Values that can't be
 * serialized at all (cycles, BigInt, …) also collapse to a marker rather than
 * throwing, so recording can never break a run.
 */
export function clampJson(
  value: unknown,
  maxBytes: number = DEFAULT_CLAMP_BYTES,
): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return {
      __truncated: true,
      bytes: -1,
      preview: "[unserializable value]",
    } satisfies ClampedMarker;
  }

  // `undefined` (e.g. JSON.stringify(undefined)) — nothing to store.
  if (serialized === undefined) return null;

  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= maxBytes) return value;

  return {
    __truncated: true,
    bytes,
    // Keep a head slice so the UI can still show *something*. Sliced on the
    // serialized string by chars; the marker itself stays tiny.
    preview: `${serialized.slice(0, 1_000)}…`,
  } satisfies ClampedMarker;
}
