import { NonRetriableError, RetryAfterError } from "inngest";
import ky, { TimeoutError } from "ky";
import { HTTP_TIMEOUT, type HttpTimeoutClass } from "./http-budget";

/**
 * The shared HTTP client and the timeout CLASSIFIER.
 *
 * Before this module the app had three timeout regimes, all of them accidental:
 * every `ky` call inherited ky's undocumented 10s default, the HR nodes hand-set 60s
 * at six call sites, and every raw `fetch` had no timeout at all (it hung until the
 * platform killed the invocation). A live Sheets read died on the first of those.
 * Nothing chose any of those numbers.
 *
 * Every outbound call now names a CLASS from `HTTP_TIMEOUT` and declares whether it
 * is safe to repeat. The class names are the stable interface; the numbers (in
 * `http-budget.ts`) are the tunable. Moving the workers off serverless later re-tunes
 * that table and touches nothing else.
 *
 * ⚠️ This module imports ky — it must never reach the client bundle. Browser code
 * (dialogs, `node-schemas.ts`) imports `./http-budget` instead, which has no deps.
 */

// The numbers live next door, but server code should only need one import.
export * from "./http-budget";
// ---------------------------------------------------------------------------
// The clients
// ---------------------------------------------------------------------------

/**
 * The background client — everything that runs inside an Inngest step.
 *
 * `retry: 0` is load-bearing. ky and Inngest both retry, and stacking them wastes
 * the step budget: ky retries GET on 408/413/429/5xx with `limit: 2`, so a 30s
 * read against a flapping 503 silently becomes ~90s inside one step and then
 * reports a single failure. Inngest retries with backoff, isolation, and a
 * visible run record. INSIDE A STEP, INNGEST OWNS RETRYING.
 *
 * (ky does NOT retry on timeout by default, and never retries POST — so the
 * duplicate-write risk here comes from Inngest's retries, not ky's.)
 *
 * Defaults to READ; every call site should still name its class explicitly.
 */
export const http = ky.create({
  retry: 0,
  timeout: HTTP_TIMEOUT.READ,
});

/**
 * The interactive client — tRPC paths where a human is waiting on a spinner.
 *
 * There is no Inngest here, so ky's retry is the only retry there is; one retry
 * on GET absorbs a blip without making the human wait through a second full
 * timeout.
 */
export const interactiveHttp = ky.create({
  retry: { limit: 1, methods: ["get"] },
  timeout: HTTP_TIMEOUT.INTERACTIVE,
});

// ---------------------------------------------------------------------------
// Classifying a timeout
// ---------------------------------------------------------------------------

/**
 * How long Inngest waits before re-attempting a timed-out call. A timeout means
 * the provider is slow right now; retrying instantly just times out again.
 */
const TIMEOUT_RETRY_AFTER = "15s";

/**
 * A ky timeout, plus the context ky itself does not carry.
 *
 * The two axes here are INDEPENDENT, and conflating them is a correctness bug:
 * `timeoutClass` says how SLOW the call is, `idempotent` says whether repeating it
 * is SAFE. They cross in every combination — Lever's "create opportunity" is slow
 * AND unsafe to repeat; Notion's `/query` is a POST that is perfectly safe to
 * repeat; a Slack webhook post is fast and double-posts if repeated.
 */
export type TimeoutContext = {
  /** Named as the USER knows it: "Google Sheets", not "sheets.googleapis.com". */
  integration: string;

  /** The CLOCK. Says nothing about retrying. */
  timeoutClass: HttpTimeoutClass;

  /**
   * The RETRY policy — REQUIRED, because there is no safe default and every call
   * site must decide deliberately.
   *
   * ⚠️ A TIMED-OUT REQUEST MAY HAVE SUCCEEDED. The response was lost, not
   * necessarily the request. So:
   *
   * - `true`  ⇒ repeating it is a no-op or harmless (any GET, a Notion query, an
   *              OAuth refresh, an LLM generation). Inngest backs off and retries.
   * - `false` ⇒ repeating it could DUPLICATE a side effect (append a second row,
   *              send a second Slack message, create a second Lever opportunity).
   *              The run FAILS VISIBLY instead, because silent duplicate data is far
   *              more expensive to discover than a failed run is to re-run.
   *
   * The real fix for the `false` cases is an idempotency key per write, so a retry
   * is a server-side no-op. Sheets and Slack webhooks have no native idempotency,
   * so that means a dedupe marker or a pre-write read. Until that exists, this is
   * the honest trade: visible failure over silent corruption.
   */
  idempotent: boolean;

  /** What the user can actually DO about it. Ends up in the run's error message. */
  hint?: string;

  /**
   * The clock actually used, when it is not the class's own — only HTTP_REQUEST,
   * whose timeout the user configures. Without this the message would quote the
   * class default ("did not respond within 30s") for a call the user gave 50s.
   */
  timeoutMs?: number;
};

/**
 * A timeout arrives in two shapes, and only one of them is a ky `TimeoutError`:
 *
 * - ky aborts with its own `TimeoutError` class.
 * - `AbortSignal.timeout()` (the raw-`fetch` sites) rejects with a `DOMException`
 *   whose `name` is `"TimeoutError"` — a different type entirely.
 *
 * Both mean the same thing, so both must classify the same way.
 */
export function isTimeout(error: unknown): boolean {
  return (
    error instanceof TimeoutError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

/** The single place a timeout's message and retry policy are decided. */
function timeoutFailure({
  integration,
  timeoutClass,
  idempotent,
  hint,
  timeoutMs,
}: TimeoutContext) {
  const seconds = Math.round((timeoutMs ?? HTTP_TIMEOUT[timeoutClass]) / 1000);

  const message = [
    `${integration} did not respond within ${seconds}s.`,
    hint,
    idempotent
      ? undefined
      : "The run was stopped here rather than retried automatically, because the " +
        "request may already have gone through — retrying it could duplicate the " +
        "result. Check before running it again.",
  ]
    .filter(Boolean)
    .join(" ");

  return idempotent
    ? new RetryAfterError(message, TIMEOUT_RETRY_AFTER)
    : new NonRetriableError(message);
}

/**
 * Turns either flavour of timeout into an error the engine and the user can both
 * act on. Returns `null` when `error` is not a timeout, so callers can chain.
 *
 * ky's `TimeoutError` carries only `Request timed out: GET https://…` — no
 * integration, no clock, no remedy — and it is NOT an `HTTPError`, so every
 * provider mapper (`toSheetsError` and friends) passes it straight through
 * unclassified. That raw string is what the user saw when their workflow died.
 */
export function asTimeoutError(
  error: unknown,
  context: TimeoutContext,
): Error | null {
  return isTimeout(error) ? timeoutFailure(context) : null;
}

/**
 * True when the error ALREADY carries a deliberate Inngest retry decision.
 *
 * Several executors end with a catch-all that re-wraps whatever it caught into a
 * `NonRetriableError`. That silently destroys the decision made further down: a
 * classified timeout, a 429 with `Retry-After`, or a transient 5xx would all be
 * flattened into "never retry this", turning a recoverable blip into a failed run.
 *
 * Any such catch-all must let these through untouched:
 *
 *   } catch (error) {
 *     await publish(...);
 *     if (carriesRetryDecision(error)) throw error;
 *     throw new NonRetriableError(...);
 *   }
 */
export function carriesRetryDecision(error: unknown): boolean {
  return isNonRetriableError(error) || isRetryAfterError(error);
}

/**
 * The two halves of `carriesRetryDecision`, for a caller that must ACT on which
 * one it is rather than merely notice that one is present.
 *
 * The self-hosted worker is that caller: `NonRetriableError` means fail the job
 * now and burn its remaining attempts, while `RetryAfterError` means schedule
 * the next attempt no earlier than the provider asked. Ignoring the second is
 * how a retry storm gets pointed at a client's Sheets quota, and it is easy to
 * miss because only four sites in this codebase produce one.
 *
 * They live HERE, beside `carriesRetryDecision`, rather than in a queue module,
 * so all three read the same way and cannot drift into disagreeing about what
 * counts as which.
 *
 * ⚠️ Both check `instanceof` **or** `err.name`, and the name check is not
 * belt-and-braces. `instanceof` compares against one module instance: a
 * duplicated `inngest` copy in `node_modules` (a transitive dependency
 * resolving its own) yields a class that fails `instanceof` while being the
 * same error in every way that matters. Failing it here silently downgrades a
 * deliberate "never retry this" into "retry it three more times", which for a
 * non-idempotent write is the duplicate-side-effect bug the timeout classifier
 * above exists to prevent. Both classes set `this.name` in their constructors
 * (verified in `inngest/components/*Error.js`), so the name is reliable.
 *
 * ⚠️ `RetryAfterError` extends `Error`, NOT `NonRetriableError` (verified in the
 * installed SDK), so these two are genuinely disjoint and a caller may test them
 * in either order. That is worth knowing rather than assuming: were it a
 * subclass, checking non-retriable first would classify every rate-limit hint as
 * permanent.
 */
export function isNonRetriableError(
  error: unknown,
): error is NonRetriableError {
  return (
    error instanceof NonRetriableError ||
    (error instanceof Error && error.name === "NonRetriableError")
  );
}

/** See `isNonRetriableError` — same contract, the retry-after half. */
export function isRetryAfterError(error: unknown): error is RetryAfterError {
  return (
    error instanceof RetryAfterError ||
    (error instanceof Error && error.name === "RetryAfterError")
  );
}

/**
 * `.catch()` handler that classifies a timeout and rethrows anything else intact.
 * Works for both ky and raw `fetch`.
 *
 * Used at the CALL SITE inside each provider lib, because that is the only code
 * that knows which timeout class it asked for — an executor's catch block, three
 * frames up, does not. The classified error then flows through the provider's
 * existing error mapper untouched (they all pass non-`HTTPError`s through), so
 * this needs no changes to any executor.
 *
 *   const res = await http
 *     .get(url, { headers, timeout: HTTP_TIMEOUT.READ })
 *     .json<T>()
 *     .catch(rethrowTimeout({ integration: "Google Sheets", timeoutClass: "READ" }));
 */
export function rethrowTimeout(context: TimeoutContext) {
  return (error: unknown): never => {
    throw asTimeoutError(error, context) ?? error;
  };
}

// ---------------------------------------------------------------------------
/**
 * The timeout signal for raw-`fetch` call sites that cannot use ky (streaming
 * downloads, multipart uploads to pre-signed URLs).
 *
 * A `fetch` with no signal has NO timeout and hangs until the platform kills the
 * invocation — surfacing as an opaque platform error rather than a node failure.
 * That is strictly worse than a wrong timeout.
 */
export function timeoutSignal(timeoutClass: HttpTimeoutClass): AbortSignal {
  return AbortSignal.timeout(HTTP_TIMEOUT[timeoutClass]);
}
