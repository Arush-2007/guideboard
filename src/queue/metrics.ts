import prisma from "@/lib/db";
import type { HeartbeatLossReason, SqlRunner } from "./jobs";

/**
 * What the queue looks like from outside, for the humans running the service.
 *
 * Sentry cannot provide this. Sentry reports errors, and a queue that is quietly
 * backing up throws nothing at all — every job is fine, there is just nobody
 * taking them. A queue whose depth you cannot see is how a service finds out
 * about an outage from its customers, so this ships with the queue rather than
 * "later".
 *
 * Two kinds of number, and the difference matters when reading them:
 *
 * - **Gauges** (`readQueueGauges`) come from the table, so they describe the
 *   whole system regardless of which process asks, and survive restarts.
 * - **Counters** (`readQueueCounters`) are in-process and ephemeral. They count
 *   events that leave no row behind — a claim losing a race, a heartbeat finding
 *   its lease gone — and they reset when the worker restarts. That is a real
 *   limitation, not an oversight: giving them their own table would put a write
 *   on the hot path of the failure modes they measure. They are read by a
 *   long-lived worker logging a summary line, and are meaningless in the Next
 *   app, where every request may be a fresh instance.
 *
 * The one number that actually matters is `oldestClaimableAgeMs`. Depth says
 * "there is work"; age says "a client's trigger fired nine minutes ago and
 * nothing has run", which is the sentence an alert should be built on.
 */

export type QueueGauges = {
  /** Jobs waiting, including those deliberately scheduled for later. */
  pending: number;
  /** Jobs waiting whose `runAt` has arrived — what a worker could take now. */
  claimable: number;
  running: number;
  /**
   * How long the oldest CLAIMABLE job has been waiting, or `null` when none is.
   *
   * Measured from `runAt` rather than `createdAt` on purpose: a job sitting in
   * backoff, or scheduled ahead, is not late — counting its wait would make
   * ordinary retries look like a backlog and train everyone to ignore the
   * number. From `runAt`, every millisecond counted is a millisecond the queue
   * genuinely failed to dispatch.
   */
  oldestClaimableAgeMs: number | null;
  /**
   * RUNNING jobs whose lease has expired — work the reaper has not returned to
   * PENDING yet. Steady state is 0. A number that stays above it means no reaper
   * is running, which is the failure where jobs are neither progressing nor
   * visibly stuck, and it is invisible in `running` alone.
   */
  expiredLeases: number;
  /** Jobs that gave up inside the window — the "visibly dead" count. */
  failedInWindow: number;
};

/**
 * Every reason a worker abandons a run mid-flight.
 *
 * ⚠️ Stated here as `HeartbeatLossReason` plus one, rather than imported from
 * `src/worker/fenced-error.ts` where the matching `FenceReason` lives. That is
 * layering, not laziness: `src/queue/` is imported by the Next app, and a
 * worker-abort concept must not travel into it — the same rule that keeps
 * `FencedError` out of this folder. The extra member is `lease-expired`, which
 * the worker CONCLUDES from silence rather than being told, so it has no
 * heartbeat counterpart by construction.
 */
export type FenceCounterReason = HeartbeatLossReason | "lease-expired";

export type QueueCounters = {
  /**
   * Claims that lost the per-workflow race and had to retry. Ordinary
   * contention, not an error — but a number climbing far faster than throughput
   * means workers are fighting over one busy workflow.
   */
  claimConflicts: number;
  /** Leases the reaper took back. The signal that the worker host is unhealthy. */
  reclaims: number;
  /**
   * Runs this process abandoned mid-flight, by reason. Anything other than zero
   * deserves reading: `lease-stolen` points at the host or the lease length,
   * `job-row-gone` at a workflow deleted under a live run, `not-running` at the
   * reaper taking a job back, and `lease-expired` at this worker being unable
   * to reach Postgres at all.
   *
   * ⚠️ Keyed by `FenceCounterReason`, not `HeartbeatLossReason`. The two differ
   * by exactly one member and it is the one that matters most here:
   * **`lease-expired` is concluded by the worker, not reported by a row**, so
   * it never passes through `heartbeatJob`. Typing this map by the heartbeat's
   * union left the self-fence — the failure mode where a partitioned worker
   * abandons *every* run it holds — as the one incident these counters could
   * not show.
   */
  fences: Record<FenceCounterReason, number>;
};

// Module scope, deliberately. One worker process, one set of counters, for its
// lifetime. `HeartbeatLossReason` is imported as a TYPE only — the value edge
// runs one way (jobs.ts imports these functions), so nothing circular exists at
// runtime.
const counters: QueueCounters = {
  claimConflicts: 0,
  reclaims: 0,
  fences: {
    "lease-stolen": 0,
    "job-row-gone": 0,
    "not-running": 0,
    "lease-expired": 0,
  },
};

export function countClaimConflict(): void {
  counters.claimConflicts += 1;
}

export function countReclaims(n: number): void {
  counters.reclaims += n;
}

/**
 * Records an abandoned run. Called by `heartbeatJob` for the three reasons a
 * row can report, and by the worker's heartbeat for `lease-expired`, which no
 * row can report.
 */
export function countFence(reason: FenceCounterReason): void {
  counters.fences[reason] += 1;
}

/** A snapshot, copied — callers must not be able to mutate the live counters. */
export function readQueueCounters(): QueueCounters {
  return { ...counters, fences: { ...counters.fences } };
}

/**
 * Every gauge, in TWO queries — the live ones together, and the historical one
 * on its own.
 *
 * The live aggregates share a scan because they read the same rows and this is
 * polled on a timer forever; splitting all six would be six round trips against
 * one narrow set, competing for the connection the heartbeat needs (parent plan
 * §6.3 hazard 1).
 *
 * ⚠️ **`failedInWindow` is separated deliberately, and the reason is measured
 * rather than argued.** It was originally a seventh `FILTER` in the query below,
 * which forced that query's `WHERE` to include `'FAILED'` — and FAILED is the
 * one status here that ACCUMULATES, because `WorkflowJob` has no retention yet
 * (parent plan §9.8). So the cost of a gauge read grew with every failure the
 * service had ever had, on a query the worker runs every 60 seconds, on the
 * deliberately tiny pool its lease heartbeat depends on.
 *
 * Adding `@@index([status, updatedAt])` alone does NOT fix that, which is the
 * part worth writing down: a `FILTER` is applied per row AFTER the scan, so the
 * planner cannot reach an index for it at all. Measured against a real Postgres
 * at 200k FAILED rows:
 *
 * | shape                                  | time     | buffers |
 * |----------------------------------------|----------|---------|
 * | one query, FAILED as a FILTER + index  | 32.7 ms  | 2668    |
 * | split out, no index                    | 23.1 ms  | 2668    |
 * | **split out, with the index**          | **0.069 ms** | **8** |
 *
 * The split is what makes the index reachable; the index is what makes the split
 * worth having. Neither alone does anything. Together the read stops scaling
 * with history at all, and the second round trip costs less than the scan it
 * replaces.
 *
 * ⚠️ Every count is cast `::int` because `count(*)` is `bigint`, which Prisma
 * hands back as a JavaScript `BigInt` — verified, not assumed. A `BigInt` throws
 * on `JSON.stringify`, so an uncast count would turn a metrics line into a
 * crash. The age is cast to `double precision` for the same reason: `EXTRACT`
 * returns `numeric`, which arrives as a Prisma `Decimal` object rather than a
 * number.
 *
 * `client` exists for the same reason it does across `./jobs` — the worker
 * polls this on a timer, and the paragraph above about not competing for the
 * heartbeat's connection is only true if this can actually be pointed at the
 * heartbeat's own pool. See `src/worker/db.ts`.
 */
export async function readQueueGauges({
  windowMinutes = 60,
  client = prisma,
}: {
  windowMinutes?: number;
  client?: SqlRunner;
} = {}): Promise<QueueGauges> {
  const [row] = await client.$queryRaw<
    {
      pending: number;
      claimable: number;
      running: number;
      oldestClaimableAgeMs: number | null;
      expiredLeases: number;
    }[]
  >`
    SELECT
      count(*) FILTER (WHERE status = 'PENDING')::int AS "pending",
      count(*) FILTER (WHERE status = 'PENDING' AND "runAt" <= now())::int
        AS "claimable",
      count(*) FILTER (WHERE status = 'RUNNING')::int AS "running",
      count(*) FILTER (
        WHERE status = 'RUNNING'
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
      )::int AS "expiredLeases",
      (EXTRACT(EPOCH FROM (
        now() - min("runAt") FILTER (WHERE status = 'PENDING' AND "runAt" <= now())
      )) * 1000)::double precision AS "oldestClaimableAgeMs"
    FROM "WorkflowJob"
    -- Output-identical to no WHERE at all: every FILTER above already narrows to
    -- one of these two. It is here for the PLANNER, so this can use the
    -- (status, runAt) index instead of scanning the table.
    --
    -- ⚠️ **'FAILED' is deliberately NOT in this list** — see the header. These
    -- two statuses are bounded by what is queued right now; FAILED is unbounded
    -- history until §9.8's retention exists, and including it made the cost of
    -- every gauge read grow with every failure the service had ever had.
    WHERE status IN ('PENDING', 'RUNNING')
  `;

  // Sequential rather than concurrent, on purpose: the control-plane pool holds
  // TWO connections and the lease heartbeat must always find one. Both of these
  // are sub-millisecond, so overlapping them would trade the thing that must
  // never block for a saving too small to measure.
  const [failed] = await client.$queryRaw<{ failedInWindow: number }[]>`
    SELECT count(*)::int AS "failedInWindow"
    FROM "WorkflowJob"
    -- An equality on status plus a range on updatedAt: exactly the shape
    -- WorkflowJob_status_updatedAt_idx serves, and an Index Only Scan in
    -- practice. As a FILTER inside the aggregate above it was unreachable.
    WHERE status = 'FAILED'
      AND "updatedAt" >= now() - (${windowMinutes}::int * interval '1 minute')
  `;

  return { ...row, failedInWindow: failed.failedInWindow };
}
