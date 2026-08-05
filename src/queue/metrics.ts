import prisma from "@/lib/db";
import type { HeartbeatLossReason } from "./jobs";

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
   * Heartbeats that found their job gone, by reason. Each one is a run this
   * process abandoned mid-flight, so anything other than zero deserves reading:
   * `lease-stolen` points at the host or the lease length, `job-row-gone` at a
   * workflow deleted under a live run.
   */
  fences: Record<HeartbeatLossReason, number>;
};

// Module scope, deliberately. One worker process, one set of counters, for its
// lifetime. `HeartbeatLossReason` is imported as a TYPE only — the value edge
// runs one way (jobs.ts imports these functions), so nothing circular exists at
// runtime.
const counters: QueueCounters = {
  claimConflicts: 0,
  reclaims: 0,
  fences: { "lease-stolen": 0, "job-row-gone": 0, "not-running": 0 },
};

export function countClaimConflict(): void {
  counters.claimConflicts += 1;
}

export function countReclaims(n: number): void {
  counters.reclaims += n;
}

export function countFence(reason: HeartbeatLossReason): void {
  counters.fences[reason] += 1;
}

/** A snapshot, copied — callers must not be able to mutate the live counters. */
export function readQueueCounters(): QueueCounters {
  return { ...counters, fences: { ...counters.fences } };
}

/**
 * Every gauge in ONE query.
 *
 * Six aggregates over one table scan, because this is polled on a timer forever:
 * six separate counts would be six round trips against the same rows, and the
 * connection they would compete for is the one the heartbeat needs (parent plan
 * §6.3 hazard 1).
 *
 * ⚠️ Every count is cast `::int` because `count(*)` is `bigint`, which Prisma
 * hands back as a JavaScript `BigInt` — verified, not assumed. A `BigInt` throws
 * on `JSON.stringify`, so an uncast count would turn a metrics line into a
 * crash. The age is cast to `double precision` for the same reason: `EXTRACT`
 * returns `numeric`, which arrives as a Prisma `Decimal` object rather than a
 * number.
 */
export async function readQueueGauges({
  windowMinutes = 60,
}: {
  windowMinutes?: number;
} = {}): Promise<QueueGauges> {
  const [row] = await prisma.$queryRaw<
    {
      pending: number;
      claimable: number;
      running: number;
      oldestClaimableAgeMs: number | null;
      expiredLeases: number;
      failedInWindow: number;
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
      count(*) FILTER (
        WHERE status = 'FAILED'
          AND "updatedAt" >= now() - (${windowMinutes}::int * interval '1 minute')
      )::int AS "failedInWindow",
      (EXTRACT(EPOCH FROM (
        now() - min("runAt") FILTER (WHERE status = 'PENDING' AND "runAt" <= now())
      )) * 1000)::double precision AS "oldestClaimableAgeMs"
    FROM "WorkflowJob"
    -- Output-identical to no WHERE at all: every FILTER above already narrows to
    -- one of these three. It is here for the PLANNER, so this can use the
    -- (status, runAt) index instead of scanning the table.
    --
    -- The rows it excludes are the ones that pile up: SUCCEEDED and CANCELLED
    -- are history, and history grows without bound until the retention in §9.8
    -- exists. Without this the cost of a gauge read is O(everything that ever
    -- ran) rather than O(what is queued now) — on a query polled forever, by the
    -- process whose heartbeat must never be starved of a connection.
    WHERE status IN ('PENDING', 'RUNNING', 'FAILED')
  `;

  return row;
}
