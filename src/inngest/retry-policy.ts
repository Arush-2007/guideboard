/**
 * How many times `executeWorkflow` retries a failed run.
 *
 * Dev used to be a hard `0`, which made every transient fault permanent: a TLS
 * handshake alert or a dropped socket — precisely what retries exist for — took
 * out the run with no second attempt. Worse than the lost run was the lost
 * signal, because "my workflow is wrong" and "the network hiccupped" became
 * indistinguishable, and the same blip could burn a whole afternoon being
 * mistaken for a bug.
 *
 * So dev now gets ONE retry by default: enough to ride out a blip, few enough
 * that a genuinely broken node still fails fast while you are iterating on it.
 * Production keeps 3. `INNGEST_RETRIES` overrides both — set it to 0 when you
 * WANT failures immediate and loud, e.g. while reproducing a real bug.
 */

/**
 * The values Inngest accepts for `retries`. It types the field as a literal
 * union (0…20) rather than `number` and exports no name for it, so this tuple
 * mirrors it — and doubles as the single source of the ceiling below, so the
 * two can't disagree. A value outside this range is rejected at function
 * REGISTRATION, which fails the whole deploy rather than just that function.
 */
const INNGEST_RETRY_VALUES = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
] as const;

export type InngestRetries = (typeof INNGEST_RETRY_VALUES)[number];

export const MAX_INNGEST_RETRIES = INNGEST_RETRY_VALUES[
  INNGEST_RETRY_VALUES.length - 1
] as InngestRetries;

export const DEFAULT_DEV_RETRIES: InngestRetries = 1;
export const DEFAULT_PRODUCTION_RETRIES: InngestRetries = 3;

/**
 * Resolves the retry count from the environment.
 *
 * A malformed `INNGEST_RETRIES` (empty, non-numeric, negative, fractional) is
 * IGNORED in favour of the default rather than coerced — `Number("")` is 0, so
 * treating garbage as a number would silently turn a typo into "never retry",
 * which is the exact failure mode this function exists to prevent. Values above
 * Inngest's ceiling are clamped, since registration would otherwise fail.
 */
export function resolveWorkflowRetries(
  env: { INNGEST_RETRIES?: string; NODE_ENV?: string } = process.env,
): InngestRetries {
  const fallback =
    env.NODE_ENV === "production"
      ? DEFAULT_PRODUCTION_RETRIES
      : DEFAULT_DEV_RETRIES;

  const raw = env.INNGEST_RETRIES?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;

  // Safe by construction: `parsed` is a non-negative integer clamped to the
  // last member of the tuple the union is built from.
  return Math.min(parsed, MAX_INNGEST_RETRIES) as InngestRetries;
}
