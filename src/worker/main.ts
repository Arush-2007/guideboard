import * as Sentry from "@sentry/nextjs";
import type { WorkflowJob } from "@/generated/prisma";
import prisma from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  claimNextJob,
  POISON_JOB_ERROR,
  reclaimExpiredJobs,
} from "@/queue/jobs";
import { readQueueCounters, readQueueGauges } from "@/queue/metrics";
import {
  assertWorkerConfig,
  HEARTBEAT_MS,
  LEASE_SECONDS,
  METRICS_MS,
  POLL_MAX_MS,
  POLL_MIN_MS,
  REAPER_MS,
  SHUTDOWN_GRACE_MS,
  WORKER_CONCURRENCY,
  WORKER_ID,
} from "./config";
import { controlPlaneDb } from "./db";
import { runJob, settleRunFailure } from "./run-job";

/**
 * The self-hosted workflow worker: a long-lived process that claims jobs off
 * Postgres and runs them.
 *
 * It is the same code the Inngest path runs — `runExecution` is runtime-neutral
 * and both entry points call it — so what lives here is only the part Inngest
 * used to provide: taking work, holding it, giving it back, and staying alive.
 *
 * Four things run concurrently, and each is a loop rather than a one-shot:
 *
 *  - **the claim loop**, adaptively polled, dispatching up to
 *    `WORKER_CONCURRENCY` runs at once without awaiting any of them
 *  - **the reaper**, which is what terminates a job that kills its worker
 *  - **the metrics line**, because a queue you cannot see the depth of is how a
 *    service finds out about an outage from its customers
 *  - **the heartbeat**, one per in-flight job, inside `runJob`
 *
 * Run it with `npm run worker:dev`. Nothing routes to it yet — that is the next
 * step — so it starts, finds nothing, and idles until a `WorkflowJob` row is
 * inserted by hand.
 */

/**
 * Flipped by `SIGTERM`. Every loop reads it; none of them are interrupted
 * mid-job by it, which is the entire point of a graceful shutdown.
 */
let stopping = false;

/**
 * Resolves the moment `stopping` is set, so a loop parked on an `await` can
 * race it rather than discovering the flag only after whatever it was waiting
 * for completes.
 */
let signalStopped: () => void = () => {};
const stopped = new Promise<void>((resolve) => {
  signalStopped = resolve;
});

/**
 * In-flight runs, so shutdown can wait for exactly them — and so the claim loop
 * knows how many slots are free. Bounded by `WORKER_CONCURRENCY`; entries
 * remove themselves when their run settles.
 */
const inFlight = new Set<Promise<unknown>>();

/**
 * The reaper pass currently in flight. Serves two jobs at once: it is the guard
 * against a tick that outlasts `REAPER_MS`, and it is what shutdown awaits so
 * the process cannot exit through a half-settled batch.
 */
let currentReap: Promise<void> | null = null;

async function main(): Promise<void> {
  // ⚠️ BEFORE the config assertion, not after. A boot refused for a missing
  // `ENCRYPTION_KEY` is exactly the failure an operator needs reported, and
  // initialising Sentry afterwards would make it the one crash that can never
  // reach Sentry at all. Initialising first costs nothing when the config is
  // fine — it performs no I/O.
  initSentry();

  // A worker missing `ENCRYPTION_KEY` would otherwise start happily and fail
  // hours later on the first node that decrypts one — as a node error, nowhere
  // near its cause.
  assertWorkerConfig();

  installSignalHandlers();

  logger.info("Worker starting", {
    workerId: WORKER_ID,
    concurrency: WORKER_CONCURRENCY,
    leaseSeconds: LEASE_SECONDS,
    // "How often does this thing talk to the database" is the number an
    // operator wants next to the lease it is derived from.
    heartbeatMs: HEARTBEAT_MS,
  });

  // The reaper and the metrics line are timers rather than steps in the claim
  // loop: they must keep running while every slot is busy, which is exactly
  // when a stuck job most needs reaping and a backlog most needs reporting.
  const reaper = setInterval(() => void reapOnce(), REAPER_MS);
  const metrics = setInterval(() => void reportQueue(), METRICS_MS);

  // ONE claim loop, dispatching up to `WORKER_CONCURRENCY` runs at a time.
  await claimLoop();

  clearInterval(reaper);
  clearInterval(metrics);

  // ⚠️ `clearInterval` stops FUTURE ticks; it does not stop the one that may be
  // running right now. A reaper tick settles up to 50 exhausted runs, each an
  // email plus several writes — disconnecting the pools and exiting underneath
  // it would leave a run half-settled: its fan-out chain advanced but its row
  // still RUNNING and no alert sent, which is the exact hole the reaper closes.
  await settledReaperTick();

  // Whatever the loop handed off is still running; wait for it, bounded, then
  // go. This is the call the grace period exists for — it is reachable only
  // because the loop dispatches without awaiting.
  await drainInFlight();

  // BOTH pools. `controlPlaneDb` is this process's own; `prisma` is the shared
  // singleton every executor and the engine run against, and it is the larger
  // of the two. Leaving either connected holds open handles that keep the
  // process alive after there is nothing left to do.
  await Promise.allSettled([
    controlPlaneDb.$disconnect(),
    prisma.$disconnect(),
  ]);

  logger.info("Worker stopped", { workerId: WORKER_ID });

  // ⚠️ BEFORE the exit below, which does not run exit handlers. Sentry buffers
  // over an async transport, so `process.exit` would discard whatever is still
  // in flight — which is exactly the errors captured during a shutdown, the
  // ones an operator needs after a bad deploy. Bounded so an unreachable Sentry
  // cannot be the thing that stops this process exiting.
  await Sentry.flush(2_000).catch(() => {});

  // ⚠️ Explicit, rather than letting the event loop drain on its own.
  //
  // A worker's contract with its orchestrator is "exit when told", and the
  // penalty for missing it is a SIGKILL after the platform's own grace period —
  // which is precisely the ungraceful shutdown the whole of this path exists to
  // avoid. One forgotten timer or undisconnected client anywhere in a module
  // graph this large would turn every deploy into that. Everything worth
  // finishing has finished by this line: the loops are done, in-flight runs are
  // drained, and both pools are closed.
  process.exit(0);
}

/**
 * Takes jobs until told to stop, backing off when there is nothing to take.
 *
 * **Adaptive**: 250 ms while work is being found, doubling to a 2 s ceiling
 * when idle, with jitter so workers do not resynchronise into a thundering
 * poll. The floor is what makes dispatch latency ~250 ms under load — roughly
 * 16× better than one Inngest step, before counting that a whole run is now one
 * dispatch rather than one per step.
 *
 * Cost is deliberately not an input to those numbers: any interval short enough
 * to be a queue keeps Neon's compute awake anyway (5-minute autosuspend), so
 * 2 s and 30 s bill the same and the shorter one is simply better.
 *
 * ⚠️ **ONE loop dispatching N runs, not N loops each running one.** The two look
 * equivalent and are not, in two ways:
 *
 *  - N loops each poll independently, so an IDLE worker issues N× the claim
 *    queries forever — at concurrency 4 and the 2 s ceiling that is ~170k/day
 *    against ~43k, every one a full `UPDATE … FOR UPDATE SKIP LOCKED` round
 *    trip, and the multiplier grows with concurrency. The property that a
 *    10-minute run must not block dispatch comes from **not awaiting the run**,
 *    which is what this does — not from having N pollers.
 *  - N loops that each `await` their own run make `inFlight` and the whole
 *    shutdown grace period unreachable: the loops cannot exit until their runs
 *    are already finished, so the drain always sees an empty set and SIGTERM
 *    waits **unboundedly** for the longest run rather than 120 s. Handing off
 *    without awaiting is what makes `drainInFlight` the thing that actually
 *    bounds it.
 */
async function claimLoop(): Promise<void> {
  let idleMs = POLL_MIN_MS;

  while (!stopping) {
    // Every slot busy: wait for one to free rather than spin on the claim.
    //
    // ⚠️ Raced against `stopped` as well as the runs. Waiting on the runs alone
    // parks this loop for as long as the shortest of them takes — so a SIGTERM
    // arriving with four long runs in flight would not be observed until one
    // finished, and `drainInFlight`'s 120 s bound would only START then. The
    // orchestrator would SIGKILL first, which is the ungraceful shutdown this
    // whole path exists to avoid.
    if (inFlight.size >= WORKER_CONCURRENCY) {
      await Promise.race([...inFlight, stopped]);
      continue;
    }

    let job: WorkflowJob | null = null;

    try {
      job = await claimNextJob({ workerId: WORKER_ID, client: controlPlaneDb });
    } catch (err) {
      // The database is unreachable or the claim itself is broken. Neither is
      // fixed by spinning, and a crash-looping worker claims nothing at all —
      // so log, back off to the ceiling, and keep trying.
      logger.error("Claim failed", err, { workerId: WORKER_ID });
      idleMs = POLL_MAX_MS;
    }

    if (!job) {
      await sleep(jitter(idleMs));
      idleMs = Math.min(idleMs * 2, POLL_MAX_MS);
      continue;
    }

    idleMs = POLL_MIN_MS;

    // ⚠️ Re-checked AFTER the await. A SIGTERM that lands while the claim is in
    // flight would otherwise start a brand-new run during shutdown — work the
    // worker had just been told not to take, which then has to fit inside the
    // remaining grace period or be abandoned mid-flight.
    //
    // Left untouched rather than handed back: this job is RUNNING with our
    // lease and nothing else, so when the lease expires the reaper returns it
    // to the queue AND refunds the attempt the claim spent (`MAX_FREE_RECLAIMS`).
    // Calling `failJob` here would be faster but would burn an attempt on a run
    // that never started, which is the one thing the refund exists to prevent.
    if (stopping) {
      logger.info("Claimed a job during shutdown; leaving it for the reaper", {
        jobId: job.id,
        workerId: WORKER_ID,
      });
      break;
    }

    // Dispatched, NOT awaited — see the header. Registered before the next
    // iteration so a SIGTERM always finds it, and self-removing so the slot
    // frees without the loop having to poll for completion.
    const running = runOne(job).finally(() => {
      inFlight.delete(running);
    });
    inFlight.add(running);
  }
}

/**
 * `runJob` plus the log line for its outcome.
 *
 * The catch is a genuine backstop, not defensiveness: `runJob` reports every
 * failure of the RUN as an outcome, so anything thrown from it is a bug in the
 * worker itself. It must still not reject — an unhandled rejection here would
 * take down the process, and `Promise.race(inFlight)` in the loop above would
 * surface it as a claim-loop failure rather than as the job's.
 */
async function runOne(job: WorkflowJob) {
  try {
    const result = await runJob({ job });
    logger.info("Job finished", {
      jobId: job.id,
      workflowId: job.workflowId,
      workerId: WORKER_ID,
      attempt: job.attempt,
      ...result,
    });
  } catch (err) {
    logger.error(
      "Worker bug: runJob threw instead of reporting an outcome",
      err,
      {
        jobId: job.id,
        workerId: WORKER_ID,
      },
    );
  }
}

/**
 * Returns expired leases to the queue, and settles the runs that are out of
 * attempts.
 *
 * ⚠️ **The settle is not bookkeeping.** `reclaimExpiredJobs` marks a job FAILED
 * when it has spent every attempt without ever reaching a failure path — the
 * poison-job case, where the process executing it died each time and nothing
 * survived to call `failJob`. Marking the JOB failed says nothing to the
 * `Execution` row, so without this the user's run reads RUNNING forever, they
 * get no failure email, and any fan-out chain it held drops every remaining
 * item silently. Nothing else can report those runs.
 */
function reapOnce(): Promise<void> {
  // A tick slower than the interval must not stack up. `reclaimExpiredJobs`
  // returns up to 50 exhausted jobs and each settle is 5-6 round trips plus an
  // email, so a bad batch can easily outlast `REAPER_MS` — and `setInterval`
  // has no overlap guard of its own. Two reapers running together would issue
  // that whole batch twice onto a 2-connection pool. Same guard, same reason,
  // as the heartbeat's in `run-job.ts`.
  //
  // The in-flight promise IS the guard, so shutdown can await the same handle
  // rather than needing a second flag to describe the same state.
  if (currentReap) return currentReap;

  currentReap = reapTick().finally(() => {
    currentReap = null;
  });
  return currentReap;
}

/** One reaper pass. Never throws — the interval and shutdown both await it. */
async function reapTick(): Promise<void> {
  try {
    const { reclaimed, exhausted } = await reclaimExpiredJobs({
      client: controlPlaneDb,
    });

    if (reclaimed > 0) {
      logger.warn("Reclaimed expired leases", {
        workerId: WORKER_ID,
        reclaimed,
      });
    }

    for (const job of exhausted) {
      // ⚠️ `logger.error(message, error, context)` — the context MUST be the
      // third argument. Passing it second makes Sentry capture a plain object
      // as the exception, which it renders as "Non-Error exception captured
      // with keys: …" and groups every poison job of every workflow into one
      // issue, with the ids an operator needs stripped out of `extra`.
      logger.error(
        "Job killed after exhausting its attempts without reporting",
        undefined,
        {
          jobId: job.id,
          workflowId: job.workflowId,
          executionId: job.executionId,
        },
      );
      await settleRunFailure({
        executionId: job.executionId,
        // The SAME sentence the queue wrote to `WorkflowJob.lastError`, not a
        // second copy of it. One event, two rows, one story — and this is the
        // half the user actually reads, in the alert email.
        error: new Error(POISON_JOB_ERROR),
        workflowId: job.workflowId,
        payload: job.payload,
        jobId: job.id,
      });
    }
  } catch (err) {
    logger.error("Reaper tick failed", err, { workerId: WORKER_ID });
  }
}

/** The reaper pass in flight, if any — what shutdown must not exit underneath. */
const settledReaperTick = (): Promise<void> => currentReap ?? Promise.resolve();

/**
 * One line a minute describing the queue.
 *
 * `oldestClaimableAgeMs` is the number that matters and the one an alert should
 * be built on: depth says "there is work", age says "a client's trigger fired
 * nine minutes ago and nothing has run".
 */
async function reportQueue(): Promise<void> {
  try {
    const gauges = await readQueueGauges({ client: controlPlaneDb });
    logger.info("Queue", {
      workerId: WORKER_ID,
      ...gauges,
      // In-process and reset by every restart — see `readQueueCounters`. Fine
      // for a long-lived worker's own log; not a cross-restart rate.
      ...readQueueCounters(),
    });
  } catch (err) {
    logger.error("Failed to read queue metrics", err, { workerId: WORKER_ID });
  }
}

/**
 * `SIGTERM`/`SIGINT`: stop claiming, let in-flight runs finish, exit.
 *
 * Without this every deploy kills mid-flight runs. With it, the normal case is
 * clean — and the abnormal case (a run longer than the grace period) is still
 * safe rather than lost: the job keeps its lease until it expires, and the
 * reaper hands it to another worker, which RESUMES it from its stored steps
 * instead of restarting it.
 *
 * A second signal exits immediately, because an operator who sends one twice
 * means it.
 */
function installSignalHandlers(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) {
        logger.warn("Second signal; exiting now", { signal });
        process.exit(1);
      }
      logger.info("Shutting down: no new jobs will be claimed", {
        signal,
        workerId: WORKER_ID,
        inFlight: inFlight.size,
      });
      stopping = true;
      // Wakes the claim loop even if it is parked waiting for a free slot.
      signalStopped();
    });
  }
}

/** Waits for in-flight runs, but not forever. */
async function drainInFlight(): Promise<void> {
  if (inFlight.size === 0) return;

  logger.info("Waiting for in-flight jobs", {
    inFlight: inFlight.size,
    graceMs: SHUTDOWN_GRACE_MS,
  });

  const timedOut = await Promise.race([
    Promise.allSettled([...inFlight]).then(() => false),
    sleep(SHUTDOWN_GRACE_MS).then(() => true),
  ]);

  if (timedOut) {
    logger.warn("Grace period expired; exiting with jobs still running", {
      inFlight: inFlight.size,
      // Says why that is survivable, in the place someone reads it during an
      // incident rather than only in a comment.
      note: "their leases will expire and the reaper will resume them from their stored steps",
    });
  }
}

/**
 * Sentry, explicitly.
 *
 * `sentry.server.config.ts` is loaded by `src/instrumentation.ts`, a **Next.js**
 * hook this process never runs — so without this call every worker error is
 * console-only, invisible to the alerting the deployment docs assume exists.
 *
 * ⚠️ `@sentry/nextjs`'s `exports` map has a `"worker"` condition that resolves
 * to the EDGE build. Node does not apply it, so running under `tsx` gets the
 * Node SDK correctly — but if this is ever bundled, pin the resolve conditions
 * or the edge SDK arrives silently.
 */
function initSentry(): void {
  // A no-op without a DSN, exactly as in the app: dev and local stay
  // console-only with zero Sentry traffic. Through `env()` so an unedited
  // `.env.example` placeholder reads as "not set" rather than as a DSN.
  const dsn =
    env(process.env.SENTRY_DSN) ?? env(process.env.NEXT_PUBLIC_SENTRY_DSN);
  if (!dsn) return;

  // ⚠️ These options mirror `sentry.server.config.ts` deliberately — same
  // product, one privacy and sampling policy. `sendDefaultPii: false` and the
  // `enabled` guard in particular are decisions, not defaults: this process
  // handles decrypted third-party credentials, so it is the LAST one that
  // should start attaching request data to events.
  Sentry.init({
    dsn,
    enabled: process.env.NODE_ENV === "production",
    environment: process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
    initialScope: { tags: { runtime: "worker", workerId: WORKER_ID } },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ±25% so that N slots and N workers do not fall into step and poll in bursts.
 * Full jitter would be wrong here — it would sometimes poll immediately, which
 * defeats the backoff the idle path is trying to achieve.
 */
const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);

main().catch(async (err) => {
  // The only path that should ever reach here is a failed boot check or a
  // database that was never reachable. Both are configuration, and both should
  // stop the container loudly rather than leave it running and claiming
  // nothing.
  logger.error("Worker exited", err, { workerId: WORKER_ID });
  // ⚠️ Flushed for the same reason the clean path does, and this one matters
  // more: `logger.error` hands the crash to Sentry's async transport, so
  // exiting immediately would drop the report for the single most important
  // error this process can produce — the one that stopped it starting.
  await Sentry.flush(2_000).catch(() => {});
  process.exit(1);
});
