/**
 * The timeout NUMBERS, with zero dependencies.
 *
 * Split out of `http.ts` for the same reason `row-match-operators.ts` is split out
 * of `row-match.ts`: `http.ts` imports ky and Inngest's error classes, and it must
 * never reach the client bundle. But the dialogs and the Zod schemas in
 * `node-schemas.ts` — both of which DO run in the browser — need the budget in
 * order to validate a user's timeout against what the platform can actually honour.
 *
 * So: numbers and pure functions here, clients and error classification in `http.ts`
 * (which re-exports everything below, so server code has a single import).
 */

// ---------------------------------------------------------------------------
// The budget model — read this before changing any number
// ---------------------------------------------------------------------------

/**
 * The longest a single Inngest STEP may run before the platform kills it.
 *
 * Inngest invokes `/api/inngest` once per `step.run`, and its retries are fresh
 * invocations with a fresh budget — so the platform ceiling constrains one step,
 * never the whole workflow. A run's total duration is already unbounded because
 * Inngest checkpoints between steps. The fix for work that does not fit is
 * therefore MORE STEPS, not a bigger timeout.
 *
 * ⚠️ CONSERVATIVE FLOOR, NOT A MEASUREMENT. 60s is a value that holds on any
 * commercial Vercel plan. Confirm the real ceiling (dashboard → function max
 * duration, and whether Fluid compute is on) and raise it here; `SLOW_API`, `LLM`
 * and `MEDIA` are the only classes currently squeezed by it.
 */
export const MAX_STEP_BUDGET_MS = 60_000;

/**
 * Everything in a step that is not the outbound call itself: Prisma reads, the
 * realtime `publish`, JSON encoding, and cold start. Deliberately generous — the
 * cost of over-reserving is a slightly shorter timeout, the cost of under-reserving
 * is the platform killing a call we promised would complete.
 */
export const STEP_OVERHEAD_MS = 5_000;

/**
 * Timeout classes. Each names HOW SLOW the call is — and nothing else.
 *
 * Whether a call may be RETRIED is a separate, orthogonal question (idempotency),
 * declared per call site in `TimeoutContext`. Do not fold the two together: Lever's
 * "create opportunity" is slow AND unsafe to repeat, while Affinda's scoring is
 * slow and perfectly safe to repeat.
 *
 * Chosen along three axes:
 *
 * 1. IS A HUMAN WAITING? Interactive tRPC must fail fast and legibly. A background
 *    step should be patient — nobody is watching, and giving up early just converts
 *    a slow success into a failed run.
 * 2. HOW MUCH WORK IS ON THE OTHER SIDE? A wide `A:ZZ` read, an LLM generating 2k
 *    tokens and a CloudConvert render are seconds-to-minutes. A Telegram
 *    `sendMessage` is not.
 * 3. WHAT DOES THE BUDGET ALLOW? See `assertTimeoutBudget`.
 */
export const HTTP_TIMEOUT = {
  /** A human is watching a spinner (tRPC: spreadsheet pickers, column loaders). */
  INTERACTIVE: 8_000,
  /** OAuth refresh. Fast, and runs INSIDE another call's budget. */
  TOKEN: 10_000,
  /** The class that failed at ky's 10s default on a wide Sheets read. */
  READ: 30_000,
  /** Ordinary API write. Same tail as READ — they differ in IDEMPOTENCY, not clock. */
  WRITE: 30_000,
  /** Genuinely slow third-party work: document parsing, ML scoring, slow enterprise CRMs. */
  SLOW_API: 45_000,
  /** LLM generation. Squeezed by MAX_STEP_BUDGET_MS — see the assertion below. */
  LLM: 45_000,
  /** Per CloudConvert REQUEST; the media flow is split across steps, not one long call. */
  MEDIA: 45_000,
} as const;

export type HttpTimeoutClass = keyof typeof HTTP_TIMEOUT;

/**
 * Classes reached only AFTER an OAuth refresh in the same step (Google, Graph,
 * YouTube, Instagram). Their real cost is `TOKEN + the call`, and the budget
 * assertion has to account for that nesting or it will under-count by 10s.
 */
const TOKEN_GUARDED: HttpTimeoutClass[] = ["READ", "WRITE"];

/** Classes that carry their own credentials (API key) — no refresh in front of them. */
const SELF_AUTHED: HttpTimeoutClass[] = ["SLOW_API", "LLM", "MEDIA"];

/**
 * The worst single step this table permits. `INTERACTIVE` is excluded: it never runs
 * inside an Inngest step, it runs inside a tRPC request.
 */
export const WORST_CASE_STEP_MS = Math.max(
  HTTP_TIMEOUT.TOKEN + Math.max(...TOKEN_GUARDED.map((c) => HTTP_TIMEOUT[c])),
  Math.max(...SELF_AUTHED.map((c) => HTTP_TIMEOUT[c])),
);

/**
 * Fails LOUDLY at import if the timeout table cannot fit under the platform's step
 * ceiling — i.e. if we would promise a caller a clock the platform will not honour,
 * and the call would die as an opaque platform error instead of a node failure. A
 * wrong ceiling should break the build, not a run at 3am.
 *
 * Exported (not just run) so a test can pin the arithmetic.
 */
export function assertTimeoutBudget(
  budgetMs: number = MAX_STEP_BUDGET_MS,
  overheadMs: number = STEP_OVERHEAD_MS,
  worstCaseMs: number = WORST_CASE_STEP_MS,
): void {
  const required = worstCaseMs + overheadMs;
  if (required > budgetMs) {
    throw new Error(
      `HTTP timeout budget exceeded: the timeout table needs ${required}ms ` +
        `(worst step ${worstCaseMs}ms + ${overheadMs}ms overhead) but the platform ` +
        `ceiling is ${budgetMs}ms. Either lower a class in HTTP_TIMEOUT or raise ` +
        `MAX_STEP_BUDGET_MS to match the deployment's real function max duration.`,
    );
  }
}

assertTimeoutBudget();

// ---------------------------------------------------------------------------
// The one timeout a USER controls
// ---------------------------------------------------------------------------

/**
 * The HTTP_REQUEST node calls arbitrary third-party APIs, so its timeout is the one
 * a user must be able to set — some enterprise APIs are legitimately slow, and no
 * number we pick is right for all of them.
 *
 * But a user must NOT be able to configure a value the platform will kill: a 300s
 * timeout under a 60s ceiling doesn't give them a 300s call, it gives them an opaque
 * platform error instead of a clean node failure. So the configured value is CLAMPED
 * to what the step budget can actually honour.
 */
export const MAX_USER_TIMEOUT_MS = MAX_STEP_BUDGET_MS - STEP_OVERHEAD_MS;

/** Below this, a timeout is almost certainly a typo (e.g. "5" meaning seconds). */
export const MIN_USER_TIMEOUT_MS = 1_000;

export const DEFAULT_USER_TIMEOUT_MS = HTTP_TIMEOUT.WRITE;

/**
 * The same bounds in SECONDS — the unit the dialog and the Zod schema speak, because
 * that is the unit a user thinks in. Milliseconds are an internal detail.
 */
export const MAX_USER_TIMEOUT_SECONDS = Math.floor(MAX_USER_TIMEOUT_MS / 1000);
export const DEFAULT_USER_TIMEOUT_SECONDS = Math.round(
  DEFAULT_USER_TIMEOUT_MS / 1000,
);

/**
 * Clamps a user-configured timeout (in MILLISECONDS) into what the platform can
 * actually deliver. Non-finite / missing / non-positive values fall back to the
 * default rather than throwing — a bad number in a config field should not fail a run
 * that would otherwise work.
 */
export function clampUserTimeout(ms: unknown): number {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_USER_TIMEOUT_MS;
  return Math.min(
    Math.max(Math.round(n), MIN_USER_TIMEOUT_MS),
    MAX_USER_TIMEOUT_MS,
  );
}
