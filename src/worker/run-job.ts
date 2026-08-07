import type { Realtime } from "@inngest/realtime";
import { settleFailedExecution } from "@/execution/failure";
import {
  FencedError,
  type FenceReason,
  isFencedError,
} from "@/execution/fenced-error";
import type { WorkflowExecutionPayload } from "@/execution/payload";
import { passthroughRunStep, runExecution } from "@/execution/run-execution";
import { workerEventId } from "@/execution/runtime";
import type { WorkflowJob } from "@/generated/prisma";
import { logger } from "@/lib/logger";
import {
  attachExecutionToJob,
  completeJob,
  diagnoseLostLease,
  failJob,
  heartbeatJob,
  type SqlRunner,
} from "@/queue/jobs";
import { countFence } from "@/queue/metrics";
import { BEATS_PER_LEASE, LEASE_SECONDS, WORKER_ID } from "./config";
import { controlPlaneDb } from "./db";
import { createWorkerStep } from "./worker-step";

/**
 * One job, end to end: claim in, outcome out.
 *
 * Split from the claim loop because this is the piece where being wrong is
 * expensive. The loop's job is scheduling; THIS file decides whether a client's
 * spreadsheet gets a second row, whether their run is marked failed while
 * another worker is still finishing it, and whether they get four emails about
 * one failure. Each of those is a specific ordering below, and each has a test.
 *
 * The shape:
 *
 * ```
 * start heartbeat (every 15 s)         ─┐
 * runExecution                          │ concurrent
 *   └ onExecutionCreated → attach       │
 * completeJob / failJob (+ settle)     ─┘
 * stop heartbeat (finally, EVERY path)
 * ```
 */

/**
 * `publish` for a process that cannot publish.
 *
 * Not laziness: `@inngest/realtime` exports no standalone publish at all —
 * `publish` is supplied by middleware INSIDE a function invocation, which this
 * is not. Carrying the Inngest client here to stream status is impossible
 * rather than merely ugly.
 *
 * ⚠️ **Consequence: the canvas does not animate for worker-run workflows.**
 * `NodeExecution` rows and the execution page are unaffected, so the run is
 * fully observable after the fact — only the live view is missing.
 * `directPublish` passes straight through, because `getAsyncCtx()` returns
 * undefined outside a function invocation.
 */
const noopPublish = (async () => {}) as unknown as Realtime.PublishFn;

export type JobOutcome =
  | { outcome: "succeeded"; executionId: string }
  /** An earlier run already owns this idempotency key. Correctly did nothing. */
  | { outcome: "duplicate"; executionId: string }
  /** We stopped owning the job mid-run. Somebody else owns the outcome. */
  | { outcome: "fenced"; reason: FenceReason }
  | { outcome: "retry-scheduled"; delayMs: number }
  /** Attempts spent: the job is FAILED and the run has been settled. */
  | { outcome: "failed"; executionId: string | null }
  /** We lost the job between the throw and reporting it. Nothing written. */
  | { outcome: "abandoned" };

/**
 * Runs a claimed job to one of the outcomes above. Does not throw for any
 * failure of the RUN — a thrown error here is a bug in this file or a database
 * that is gone, and the claim loop treats it as such.
 */
export async function runJob({
  job,
  workerId = WORKER_ID,
  client = controlPlaneDb,
  leaseSeconds = LEASE_SECONDS,
}: {
  /** A row from `claimNextJob`, still held by this worker. */
  job: WorkflowJob;
  workerId?: string;
  /**
   * The CONTROL-PLANE client, for the queue writes and the heartbeat — never
   * the execution pool. See `./db`; the whole point is that a saturated
   * execution pool cannot starve the heartbeat.
   */
  client?: SqlRunner;
  /**
   * The lease this run takes and renews.
   *
   * ⚠️ **ONE seam, not two, and that is deliberate.** The beat interval and the
   * self-fence threshold are both DERIVED from this (see `startHeartbeat`), so
   * shortening the lease shortens them in the same ratio. An earlier shape
   * injected the beat interval instead and left the lease at its 60 s constant,
   * which meant the fencing test ran a 100 ms self-fence against a real 60 s
   * lease — exercising a ratio that exists nowhere else and quietly proving
   * nothing about the one that ships. `config.ts` states the rule this restores:
   * it must not be possible to change one without seeing its partner.
   *
   * Injectable so the fencing test runs in seconds rather than lease-lengths,
   * against the REAL heartbeat. Same reason `failJob` takes a `random`.
   */
  leaseSeconds?: number;
}): Promise<JobOutcome> {
  const payload = (job.payload ?? {}) as WorkflowExecutionPayload;
  const controller = new AbortController();
  const heartbeat = startHeartbeat({
    jobId: job.id,
    workerId,
    client,
    controller,
    leaseSeconds,
  });

  // Assigned from inside `onExecutionCreated`. Tracked because the triage has
  // to know whether an `Execution` row exists at all: `settleFailedExecution`
  // throws when it does not, and a run that failed before item 2 has nowhere to
  // be recorded but the job row's `lastError`.
  let executionId: string | null = null;

  try {
    const result = await runExecution({
      workflowId: job.workflowId,
      // ⚠️ `Execution.inngestEventId` is NOT NULL and unique, and a worker run
      // has no Inngest event. This synthetic value is globally unique, needs no
      // schema change, and doubles as the correlation id from a run back to its
      // queue row.
      //
      // **It is also what makes resume work.** It is stable across every
      // attempt of one job, so `create-execution`'s upsert ADOPTS the row a
      // crashed attempt made rather than creating a second one — and a plain
      // `create` would instead strand the job on that unique constraint for
      // every remaining attempt, turning a transient fault permanent.
      //
      // Built by the shared helper because the routing seam READS this format
      // back (`isWorkerEventId`) to keep a fan-out chain on one runtime.
      inngestEventId: workerEventId(job.id),
      payload,
      // Safe only because items 1-4 are pure reads and item 6 is idempotent.
      // Read its comment before substituting anything.
      runStep: passthroughRunStep,
      engineStepFor: (id) =>
        createWorkerStep({ executionId: id, signal: controller.signal }),
      publish: noopPublish,
      onExecutionCreated: async (id) => {
        executionId = id;
        const held = await attachExecutionToJob({
          jobId: job.id,
          workerId,
          executionId: id,
          client,
        });
        // ⚠️ `false` means the ownership guard matched nothing — we were fenced
        // between the claim and here. Throwing STOPS the run now rather than
        // letting it execute a whole workflow it does not own.
        if (!held) {
          throw new FencedError(
            await probeFenceReason({ jobId: job.id, workerId, client }),
            "This worker no longer held the job when its execution row was " +
              "created; abandoning the run before any node executes.",
          );
        }
      },
    });

    // ⚠️ BEFORE the terminal write, not just in the `finally`. `completeJob`
    // sets `lockedBy = NULL`; a renewal already in flight when it commits then
    // matches zero rows and is reported as `lease-stolen` — counting a fence
    // and aborting the controller on a run that in fact finished perfectly.
    // Every healthy run has a round-trip-wide window to do that once per beat,
    // which would make `fences.lease-stolen` — documented as "the signal that
    // the worker host is unhealthy" — climb steadily on a healthy host.
    heartbeat.stop();

    // A duplicate did its work by correctly doing nothing: an earlier
    // `Execution` owns this key, and advancing a fan-out chain from here would
    // race the sibling that still holds it. It still gets the id recorded on
    // the job row, because `onExecutionCreated` never fired for it and the
    // correlation from a queue row back to its run is the whole second purpose
    // of `attachExecutionToJob`.
    if (result.skipped) {
      await attachExecutionToJob({
        jobId: job.id,
        workerId,
        executionId: result.existingExecutionId,
        client,
      });
    }

    const finished = await completeJob({ jobId: job.id, workerId, client });
    if (!finished) return { outcome: "abandoned" };

    return result.skipped
      ? { outcome: "duplicate", executionId: result.existingExecutionId }
      : { outcome: "succeeded", executionId: result.executionId };
  } catch (err) {
    // Same reason as above: `failJob` also clears `lockedBy`.
    heartbeat.stop();
    return triageFailure({
      job,
      payload,
      workerId,
      client,
      error: err,
      executionId,
    });
  } finally {
    // EVERY path. A leaked interval renews the lease of a run that is over,
    // which makes the job unreclaimable for as long as the process lives.
    heartbeat.stop();
  }
}

/**
 * What to do about a run that threw — the highest-risk ordering in the worker.
 *
 * ⚠️ **The order is not the obvious one, and each step is a specific bug.**
 */
async function triageFailure({
  job,
  payload,
  workerId,
  client,
  error,
  executionId,
}: {
  job: WorkflowJob;
  /** Passed in rather than re-coerced from `job.payload`; `runJob` has it. */
  payload: WorkflowExecutionPayload;
  workerId: string;
  client: SqlRunner;
  error: unknown;
  executionId: string | null;
}): Promise<JobOutcome> {
  // 1. FENCED FIRST, and it must reach neither `failJob` nor the settle.
  //
  // A fenced worker does not own this job any more. Marking the run FAILED
  // would mark failed a run another worker is at that moment finishing
  // SUCCESSFULLY — the fencing bug reappearing one layer up. Being fenced also
  // says nothing about whether the work is retriable, so it must not spend an
  // attempt either.
  if (isFencedError(error)) {
    logger.warn("Worker fenced mid-run; abandoning the job", {
      jobId: job.id,
      workerId,
      executionId,
      reason: error.reason,
      message: error.message,
    });
    return { outcome: "fenced", reason: error.reason };
  }

  // 2. LET THE QUEUE DECIDE WHETHER THE RUN IS OVER, before recording anything.
  //
  // Inngest's `onFailure` fires ONCE, after the last retry is spent. Settling
  // on every attempt would mark the row FAILED mid-retry, advance the fan-out
  // chain early, and email the owner once per attempt for one run.
  //
  // The raw error goes in deliberately: `failJob` already discriminates
  // `NonRetriableError` (spend every attempt), `RetryAfterError` (honour the
  // provider's delay, floored at the backoff) and everything else.
  // Pre-classifying here would be a second, drifting copy of that decision.
  const result = await failJob({ job, workerId, error, client });

  if (result.outcome === "not-owned") {
    // Fenced between the throw and this write. The lease holder owns the
    // outcome; anything written from here would be about someone else's run.
    logger.warn("Job was no longer ours when its failure was recorded", {
      jobId: job.id,
      workerId,
      executionId,
    });
    return { outcome: "abandoned" };
  }

  if (result.outcome === "retry-scheduled") {
    // ⚠️ The `Execution` row stays RUNNING, and that is correct rather than a
    // leak: the run is not over. Attempt 2 re-enters, the upsert re-finds this
    // same row, its completed steps fast-forward, and success writes SUCCESS
    // over it. A row only reaches FAILED when the job is genuinely out of
    // attempts — which is exactly what Inngest does today.
    logger.warn("Workflow job failed; retry scheduled", {
      jobId: job.id,
      workerId,
      executionId,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      delayMs: result.delayMs,
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: "retry-scheduled", delayMs: result.delayMs };
  }

  // 3. EXHAUSTED. Only now is the run genuinely over, so only now is it
  //    settled: the chain advance, the FAILED write, the Sentry capture and
  //    the one alert email.
  //
  //    ⚠️ Skipped when no row exists. `runExecution` can throw before item 2
  //    (a malformed payload, a deleted workflow), and `settleFailedExecution`
  //    throws on a missing row — deliberately. `failJob`'s `lastError` is the
  //    record in that case, which is strictly better than Inngest manages: it
  //    addresses rows by `inngestEventId` and cannot report a pre-row failure
  //    at all.
  await settleRunFailure({
    executionId,
    error,
    workflowId: job.workflowId,
    payload,
    jobId: job.id,
  });

  return { outcome: "failed", executionId };
}

/**
 * Records a run as FAILED, best-effort — the shared half of the two places a
 * run can end without anyone left to report it.
 *
 * Two callers, and the second is easy to miss: `triageFailure` above, and the
 * REAPER, when `reclaimExpiredJobs` marks a job FAILED for running out of
 * attempts without ever reaching a failure path. Without the second, a job that
 * kills its worker on every attempt leaves the user's run reading RUNNING
 * forever, with no email and a fan-out chain that silently stops.
 *
 * Never throws. The job row is already terminal by the time this runs, so a
 * failure here must not take down the loop that called it — but it is a real
 * fault and is logged as one.
 */
export async function settleRunFailure({
  executionId,
  error,
  workflowId,
  payload,
  jobId,
}: {
  executionId: string | null;
  error: unknown;
  workflowId: string;
  payload: WorkflowExecutionPayload;
  jobId: string;
}): Promise<void> {
  if (!executionId) return;

  try {
    await settleFailedExecution({
      locate: { id: executionId },
      error,
      workflowId,
      fanOutChain: payload.fanOutChain,
    });
  } catch (err) {
    logger.error("Failed to record a failed run against its execution", err, {
      jobId,
      executionId,
    });
  }
}

/**
 * Why an ownership-guarded write matched no row.
 *
 * Reuses the heartbeat's own diagnosis rather than restating its three-way
 * logic, so there is no second copy to drift — but calls it directly rather
 * than through `heartbeatJob`, which would also issue a renewal that cannot
 * succeed just to read the answer. See the body for the metric consequence.
 *
 * ⚠️ It is not cheap — a SELECT on top of the write that already failed — which
 * is affordable only because this runs exclusively on a path that has already
 * gone wrong and is about to abandon the run; do not reach for it anywhere warm.
 */
async function probeFenceReason({
  jobId,
  workerId,
  client,
}: {
  jobId: string;
  workerId: string;
  client: SqlRunner;
  // No `leaseSeconds`: it existed only to feed the renewal this no longer does.
}): Promise<FenceReason> {
  // `diagnoseLostLease` directly rather than `heartbeatJob`, then count once
  // here. We already KNOW the lease is gone — `attachExecutionToJob` just
  // returned false on the same ownership predicate — so the only thing wanted
  // is the NAME, and routing that through `heartbeatJob` issued a renewal that
  // cannot succeed purely as a way of reading it.
  //
  // The count is kept (rather than dropped along with the renewal) because this
  // is a real fence and `heartbeatJob`'s loss path is what used to record it.
  // Removing both would under-count, which is worse than over-counting for a
  // number whose job is to say "this host is unhealthy".
  //
  // ⚠️ Residual, and deliberately left: if the heartbeat TIMER already observed
  // the same loss on an earlier tick, that tick counted too, so one logical
  // fence can still register twice. Fixing it properly means counting where a
  // fence becomes an OUTCOME rather than in each discovery site — a change
  // across three functions in the path Step 5's worst defects lived in, which
  // is not something to fold into this step. Parent plan §9.68.
  const reason = await diagnoseLostLease(jobId, workerId, client);
  countFence(reason);
  return reason;
}

/**
 * Renews the lease on a timer, and aborts the run the moment it cannot.
 *
 * The abort reason is always a `FencedError`, which is what lets
 * `assertNotFenced` rethrow it with its cause intact instead of degrading to
 * "cause unknown".
 *
 * ⚠️ The fence trips at STEP BOUNDARIES, because that is where our code regains
 * control. It cannot interrupt a call already in flight. That window is the
 * same one Inngest has and is bounded by the HTTP timeout table.
 */
function startHeartbeat({
  jobId,
  workerId,
  client,
  controller,
  leaseSeconds,
}: {
  jobId: string;
  workerId: string;
  client: SqlRunner;
  controller: AbortController;
  leaseSeconds: number;
}): { stop: () => void } {
  const leaseMs = leaseSeconds * 1000;
  /**
   * Both timings come from the ONE lease, so the 1:4 ratio the design rests on
   * cannot be broken by changing a single number — and a shortened lease (the
   * fencing test) exercises the shipping ratio rather than a made-up one.
   */
  const heartbeatMs = leaseMs / BEATS_PER_LEASE;

  /**
   * When this worker last successfully RENEWED, on this worker's own clock.
   *
   * Deliberately not `leaseExpiresAt` from the database. Comparing Postgres'
   * clock against `Date.now()` would make the self-fence below depend on the
   * container's clock agreeing with the database's — a skewed container would
   * either fence every run instantly or never. Measuring elapsed time between
   * two readings of ONE clock has no such failure mode, and the network latency
   * it silently includes errs toward fencing early, which is the safe side.
   */
  let lastRenewedAt = Date.now();
  let beating = false;

  /**
   * How long without a successful renewal before this worker assumes the job is
   * gone.
   *
   * ⚠️ **One beat SHORT of the lease, and the margin is the point.** At exactly
   * `leaseMs` the fence would fire at the same instant `leaseExpiresAt` passes
   * and `reclaimExpiredJobs` becomes entitled to hand the job to another worker
   * — and since the fence only takes effect at the next STEP BOUNDARY, this
   * worker would reliably still be executing after its replacement had started.
   * Fencing a beat early means the abort strictly precedes the reaper.
   */
  const fenceAfterMs = leaseMs - heartbeatMs;

  const fence = (reason: FenceReason, message?: string) => {
    // `abort` is idempotent, but the log line is not — and a fenced run keeps
    // hitting step boundaries until it unwinds.
    if (controller.signal.aborted) return;
    controller.abort(new FencedError(reason, message));
  };

  const beat = async () => {
    // ⚠️ **The staleness check runs FIRST, on EVERY tick, and deliberately
    // BEFORE the re-entrancy guard below.**
    //
    // A heartbeat does not only fail by throwing — against a blackholed TCP
    // connection (packets dropped with no RST, which is the classic partition
    // and the exact case this fence exists for) the query never settles at all.
    // It therefore never reaches the catch, `beating` stays true forever, and a
    // staleness check living in the catch would be skipped on every subsequent
    // tick by the very guard meant to stop renewals stacking up. The worker
    // would keep executing for hours on a job the reaper had already reassigned
    // — two processes, one run, which is the failure the whole design forbids.
    //
    // Hoisted here, the check is a pure clock comparison that cannot block, so
    // a hung renewal and a throwing one fence on the same schedule.
    const staleMs = Date.now() - lastRenewedAt;
    if (staleMs >= fenceAfterMs) {
      // Counted HERE because no row reports this one — `heartbeatJob` counts
      // the three it can answer, and this is the fourth it never sees.
      if (!controller.signal.aborted) countFence("lease-expired");
      fence(
        "lease-expired",
        `This worker has been unable to renew its lease for ${Math.round(
          staleMs / 1000,
        )}s, so another worker is about to be entitled to this job; ` +
          "abandoning the run.",
      );
      return;
    }

    // A beat slower than the interval must not stack up: overlapping renewals
    // would burn the control plane's two connections on a database that is
    // already struggling, which is the moment they are most needed.
    if (beating) return;
    beating = true;
    try {
      const result = await heartbeatJob({
        jobId,
        workerId,
        leaseSeconds,
        client,
      });

      if (result.held) {
        lastRenewedAt = Date.now();
        return;
      }
      // An authoritative answer: the row says we do not hold this.
      fence(result.reason);
    } catch (err) {
      // ⚠️ **A heartbeat that THROWS is not a fence, and treating it as one
      // would abort every run on a one-second database blip.** Tolerated and
      // logged; the staleness check at the top of the next tick is what turns a
      // sustained outage into a fence, so nothing is needed here but the record.
      logger.warn("Heartbeat failed; still inside the lease, continuing", {
        jobId,
        workerId,
        staleMs: Date.now() - lastRenewedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      beating = false;
    }
  };

  const timer = setInterval(() => void beat(), heartbeatMs);
  // Idempotent: `runJob` stops the heartbeat before its terminal write AND
  // again in its `finally`, and `clearInterval` on a cleared handle is a no-op.
  return { stop: () => clearInterval(timer) };
}
