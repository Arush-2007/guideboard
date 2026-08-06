import { hostname } from "node:os";
import { createId } from "@paralleldrive/cuid2";
import { env } from "@/lib/env";
import {
  describeMissingSettings,
  missingProductionSettings,
} from "@/lib/production-config";
import { DEFAULT_LEASE_SECONDS } from "@/queue/jobs";

/**
 * Who this worker is, how hard it works, how often it looks — and what it
 * refuses to start without.
 *
 * Everything here is either derived from a number the queue already owns or
 * overridable from the environment. Nothing is a magic constant chosen at the
 * call site, because two of these numbers are load-bearing for correctness
 * (the heartbeat interval, the lease) and it must not be possible to change one
 * without seeing its partner.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * This process's name in the `lockedBy` column: stable for its whole life,
 * unique across every process that will ever run.
 *
 * ⚠️ **The random suffix is the load-bearing part, and hostname+pid alone would
 * be wrong.** Containers restart with the same hostname, and pids are recycled
 * aggressively in a small container — so a restarted worker can be born with
 * the exact identity of the one that just died. That worker's abandoned jobs
 * are still RUNNING with `lockedBy` set to that identity for up to a lease, and
 * the new process would be able to renew, complete or fail them: it would
 * inherit ownership of runs it never started, and the reaper's rescue of those
 * runs would silently stop working. The suffix makes a restart a genuinely new
 * worker, which is what it is.
 *
 * The hostname and pid stay because they are what makes a `lockedBy` value
 * useful in an incident — "which container, which process" — and the suffix
 * costs nothing.
 *
 * Overridable so an operator can pin a name, but the default is the safe one.
 */
export const WORKER_ID =
  env(process.env.WORKER_ID) ??
  `${hostname()}-${process.pid}-${createId().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/**
 * How many runs this process executes at once.
 *
 * **4, because the workload is I/O-bound.** A run spends nearly all of its
 * wall-clock time awaiting Sheets, Slack or an LLM; at concurrency 1 the process
 * would sit idle through every one of those waits. The connection budget in the
 * parent plan's §6.3 is derived from exactly this number
 * (`connection_limit=10`), so changing one means revisiting the other.
 *
 * ⚠️ **It only buys throughput ACROSS workflows.** The partial unique index
 * allows one RUNNING job per workflow — a correctness guarantee that fan-out
 * item ordering depends on — so a single customer hammering a single workflow
 * gets no benefit from any value above 1. The benefit arrives with the second
 * concurrent workflow.
 */
export const WORKER_CONCURRENCY = positiveInt(
  process.env.WORKER_CONCURRENCY,
  4,
);

/** The lease this worker takes, and renews. The queue owns the value. */
export const LEASE_SECONDS = DEFAULT_LEASE_SECONDS;

/**
 * How many heartbeats fit in one lease — i.e. how many must be MISSED before
 * the lease can expire.
 *
 * The single place the ratio lives. `startHeartbeat` derives both its beat
 * interval and its self-fence threshold from it and the lease, so neither can
 * be changed without the other following.
 *
 * Four is headroom against SYNCHRONOUS work only — awaiting a 55 s HTTP call
 * does not block a timer — and the longest synchronous span in the codebase is
 * the Code node's 1 s QuickJS interrupt deadline.
 */
export const BEATS_PER_LEASE = 4;

/**
 * How often the lease is renewed, derived rather than written down twice, as
 * `DEFAULT_LEASE_SECONDS`' own comment insists.
 *
 * ⚠️ Nothing on the hot path reads this — `runJob` takes the LEASE and derives
 * the beat itself, so a shortened lease scales both. It is kept for the boot
 * log, where "how often does this thing talk to the database" is the number an
 * operator wants.
 */
export const HEARTBEAT_MS = (LEASE_SECONDS * 1000) / BEATS_PER_LEASE;

/**
 * How often the reaper runs.
 *
 * Not optional and not merely hygiene: it is the ONLY thing that terminates a
 * job that kills its worker outright, because such a job never reaches
 * `failJob` — nothing survives to call it. See `reclaimExpiredJobs`.
 */
export const REAPER_MS = 30_000;

/**
 * Poll floor and ceiling for the claim loop.
 *
 * 250 ms while work is being found; backing off to 2 s when idle. Chosen on
 * latency and query volume alone — **cost is not an input**, because any
 * interval short enough to function as a queue keeps Neon's compute awake
 * anyway (its autosuspend threshold is 5 minutes). There is no interval that is
 * both a working queue and lets the compute sleep, so 2 s and 30 s bill
 * identically and the shorter one is simply better.
 */
export const POLL_MIN_MS = 250;
export const POLL_MAX_MS = 2_000;

/** How often the queue's depth and oldest-claimable age are logged. */
export const METRICS_MS = 60_000;

/**
 * How long a `SIGTERM` waits for in-flight runs before the process exits
 * regardless.
 *
 * Exiting anyway is safe rather than lossy: whatever was still running keeps
 * its lease until it expires, and the reaper then returns it to the queue for
 * another worker to RESUME from its stored steps — not restart. The grace
 * period exists to make that the uncommon path, not to be the only thing
 * standing between a deploy and a lost run.
 */
export const SHUTDOWN_GRACE_MS = 120_000;

/**
 * Reads a positive integer setting, ignoring garbage in favour of the default.
 *
 * Ignored rather than coerced, for the reason `resolveWorkflowRetries` gives
 * about the same shape of parse: `Number("")` is 0, so treating a typo as a
 * number would turn `WORKER_CONCURRENCY=` into a worker that executes nothing
 * at all and looks perfectly healthy while doing it.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

// ---------------------------------------------------------------------------
// Boot check
// ---------------------------------------------------------------------------

/**
 * The worker's own version of `assertProductionConfig`.
 *
 * It needs one because that function is called from `src/instrumentation.ts`, a
 * **Next.js** hook this process never runs — so without this, a worker deployed
 * with a missing `ENCRYPTION_KEY` starts happily and then fails on the first
 * node that decrypts a credential, hours later, as a node error rather than as
 * a configuration error.
 *
 * ⚠️ **The default list is wrong for a worker, so it passes its own.**
 * `BETTER_AUTH_SECRET` signs session cookies and `INNGEST_SIGNING_KEY` verifies
 * inbound HTTP signatures; this process serves no HTTP and has no sessions.
 * Demanding them would be asking an operator to invent secrets for surface that
 * does not exist here — the same mistake the module warns against for
 * per-integration webhook secrets.
 *
 * The two it does demand are the two whose absence is unsafe rather than merely
 * limiting: without `DATABASE_URL` there is no queue, and without
 * `ENCRYPTION_KEY` every stored third-party credential this worker decrypts is
 * unprotected. That is what makes the worker's host and image
 * production-secret-bearing.
 *
 * `RequiredSetting` is not exported from that module, so the array is written as
 * an object literal and accepted structurally. Each `value` is a LITERAL
 * `process.env.X` — pointless in this process, which Next never compiles, but
 * kept so one convention covers both call sites rather than two.
 *
 * ⚠️ **Unconditional, where `assertProductionConfig` is production-only**, and
 * the difference is deliberate. That function exempts dev so a fresh clone can
 * `npm run dev` on an unedited `.env` and explore a working app. There is no
 * equivalent here: a worker with neither setting cannot claim a job or run a
 * node, so "boots in dev and does nothing" would be a worse first experience
 * than a sentence naming the variable to fill in.
 */
export function assertWorkerConfig(): void {
  const missing = missingProductionSettings([
    {
      key: "DATABASE_URL",
      value: process.env.DATABASE_URL,
      because: "the worker cannot reach its queue or its database without it",
    },
    {
      key: "ENCRYPTION_KEY",
      value: process.env.ENCRYPTION_KEY,
      because:
        "the worker decrypts every stored third-party API key and OAuth token " +
        "with it, so without it no node that calls an integration can run",
    },
  ]);

  if (missing.length > 0) throw new Error(describeMissingSettings(missing));
}
