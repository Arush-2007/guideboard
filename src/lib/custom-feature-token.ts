/**
 * Encoding/decoding for "custom feature" tokens.
 *
 * A custom feature forces a mapped field of a specific node to behave a certain
 * way (e.g. an auto-incrementing serial column). Selecting the feature in the
 * variable picker inserts a token as that field's value; the node's executor
 * intercepts the token before templating and applies the behavior.
 *
 * The token deliberately wears the `@<…>@` placeholder shape so that any
 * executor which does NOT support the feature resolves it to an empty string
 * (fail-safe) through the normal templating path (`renderTemplate` →
 * `getByPath`), instead of leaking a literal marker into output.
 *
 * Shape: `@<custom:<featureId>?<key>=<value>&…>@`
 *   e.g. `@<custom:serialNumber?start=1&pad=4>@`
 */

export type CustomFeatureToken = {
  featureId: string;
  /** Raw string params (query-string decoded); callers coerce as needed. */
  params: Record<string, string>;
};

// Anchored: the ENTIRE (trimmed) value must be the token, so a mapping that
// merely contains a token (mixed with other text) is NOT treated as a feature.
const CUSTOM_TOKEN_RE = /^@<custom:([a-zA-Z0-9_]+)(?:\?([^>]*))?>@$/;

export function encodeCustomFeatureToken(
  featureId: string,
  params: Record<string, string | number> = {},
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(v));
  }
  const query = qs.toString();
  return query ? `@<custom:${featureId}?${query}>@` : `@<custom:${featureId}>@`;
}

export function parseCustomFeatureToken(
  value: string | null | undefined,
): CustomFeatureToken | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(CUSTOM_TOKEN_RE);
  if (!match) return null;
  const [, featureId, query] = match;
  const params: Record<string, string> = {};
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) {
      params[k] = v;
    }
  }
  return { featureId, params };
}
