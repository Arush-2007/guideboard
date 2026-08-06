import { createId } from "@paralleldrive/cuid2";
import type { WorkflowExecutionPayload } from "@/execution/payload";
import { Prisma, type WorkflowJob } from "@/generated/prisma";
import { resolveWorkflowRetries } from "@/inngest/retry-policy";
import prisma from "@/lib/db";
import { isNonRetriableError, isRetryAfterError } from "@/lib/http";
import { countClaimConflict, countFence, countReclaims } from "./metrics";

/**
 * The job queue: how a workflow run gets from "something triggered it" to "a
 * worker is executing it", and back again whatever happens next.
 *
 * In one sentence: a worker takes exactly ONE job at a time per workflow, holds
 * it with a lease it can lose, and gives it back — and every failure mode ends
 * with the job either retried on a sane schedule or visibly dead, never silently
 * stuck and never running twice.
 *
 * These are pure functions over rows. There is no loop, no timer and no process
 * here; the worker that calls them in order is a later step.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE CLAIM NEEDS BOTH A FILTER AND AN INDEX
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This module replaces Inngest's `concurrency: { key: workflowId, limit: 1 }`,
 * which is a correctness guarantee rather than a throughput setting: two runs of
 * one workflow in flight together race on the same spreadsheet or inbox, and
 * break fan-out item ordering.
 *
 * It is enforced in two places that look redundant and are not:
 *
 * 1. `NOT EXISTS (… WHERE status = 'RUNNING')` inside the claim is the FAST
 *    FILTER. It removes essentially all contention, and stops a worker from
 *    repeatedly picking jobs it cannot run.
 * 2. The partial unique index `WorkflowJob_one_running_per_workflow` is the
 *    GUARANTEE. `FOR UPDATE SKIP LOCKED` lets two workers select two DIFFERENT
 *    pending jobs of the same workflow in the same instant — neither sees the
 *    other, because neither has flipped to RUNNING yet — so the filter alone
 *    does not close that race. The loser's UPDATE raises a unique violation,
 *    which is contention, not an error, and is retried.
 *
 * The guarantee is a row constraint rather than `pg_advisory_lock` because
 * advisory locks are session-scoped, and PgBouncer in transaction mode (Neon's
 * pooled endpoint, which is what `DATABASE_URL` points at) hands the underlying
 * session to another client between statements.
 *
 * ⚠️ Fan-out item ORDER depends on the per-workflow limit being exactly 1: the
 * chain relies on a child never starting before its parent run has finished.
 * Raising it later re-introduces the shuffled-rows bug `src/inngest/fan-out.ts`
 * documents. That constraint travels with this code.
 */

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/**
 * How long a claim is good for without a heartbeat.
 *
 * **Step length is not what this number has to clear**, and reading it that way
 * is the trap. The heartbeat is a timer: it fires perfectly well while a 55 s
 * API call is awaited, because awaiting does not block the event loop. The only
 * thing that can actually starve it is SYNCHRONOUS work, and the longest
 * synchronous span in the codebase is the CODE node's 1 s QuickJS interrupt
 * deadline plus a `JSON.stringify` over a clamped context.
 *
 * So the real budget is four missed beats (60 s) against ~1 s of possible
 * blocking, which is enormous headroom. State it that way rather than by
 * comparison with a step: `WORST_CASE_STEP_MS` is 45 s, but the HTTP node's
 * user-configurable timeout is clamped to `MAX_USER_TIMEOUT_MS` = 55 s
 * (`http-budget.ts`), so "60 s comfortably exceeds the longest step" was never
 * quite true — it exceeds it by 5 s, and that margin is not what makes this
 * safe.
 *
 * ⚠️ Whoever schedules the heartbeat must derive its interval from this rather
 * than hard-coding a second number: a quarter of the lease, so four beats must
 * be missed before eviction.
 */
export const DEFAULT_LEASE_SECONDS = 60;

/**
 * How many lease losses refund the attempt they cost. See `reclaimExpiredJobs`
 * for the arithmetic and why the two counters are separate at all.
 */
export const MAX_FREE_RECLAIMS = 2;

/** Exponential backoff base and ceiling. See `computeBackoffMs`. */
export const RETRY_BASE_MS = 10_000;
export const RETRY_CAP_MS = 300_000;

/**
 * How many times one `claimNextJob` call re-tries after losing the per-workflow
 * race. Bounded so a single hot workflow cannot spin a worker; the caller's own
 * poll loop comes round again shortly anyway.
 */
export const MAX_CLAIM_CONFLICT_RETRIES = 3;

/**
 * Ceiling on the stored `lastError` text. The column is `@db.Text` and would
 * take anything, but a provider that answers an error with a whole HTML page
 * should not put a megabyte in a row that gets read to render a list.
 */
const MAX_LAST_ERROR_CHARS = 4_000;

/**
 * Accepts the singleton client, a transaction client, or a worker's dedicated
 * control-plane client.
 *
 * Two unrelated capabilities ride on this one parameter, and both need it:
 *
 * 1. **Enqueue can sit inside the CALLER's transaction** — the thing an
 *    off-the-shelf queue library could not give us, since its enqueue holds its
 *    own pool.
 * 2. **The worker can run its claim loop and heartbeat on a pool of their own**,
 *    separate from the one its runs execute against. That is a correctness
 *    requirement, not tuning: if the execution pool saturates, a heartbeat
 *    sharing it cannot renew, and the worker fences ITSELF — a self-inflicted
 *    outage that presents as a mystery abort. See `src/worker/db.ts`.
 *
 * ⚠️ Deliberately narrow — `$queryRaw` and nothing else. Widening it to admit a
 * model delegate would drag in the `PrismaClient` vs `TransactionClient`
 * difference and make the type dishonest about what a transaction client can
 * do. `diagnoseLostLease` was rewritten as a raw SELECT to keep it this narrow;
 * anything added here should be too.
 */
export type SqlRunner = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * "This worker still holds this job." Every write that finishes or advances a
 * job carries it, and it is the single mechanism stopping two workers from ever
 * touching one job — a fenced worker's last write must land on nothing.
 *
 * ⚠️ **One fragment rather than the same three lines in four statements**, and
 * that is a correctness measure, not tidiness. The predicate is raw SQL, so no
 * compiler checks that the four copies agree; a later edit — a new terminal
 * status, a soft-delete column — landing in three of them and not the fourth
 * silently reopens the double-execution hazard this whole module is built
 * against. A drifted string is invisible until two workers actually collide.
 */
const heldBy = (jobId: string, workerId: string) =>
  Prisma.sql`id = ${jobId} AND "lockedBy" = ${workerId} AND status = 'RUNNING'`;

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export type EnqueueResult =
  | { enqueued: true; jobId: string }
  /** An identical `(workflowId, idempotencyKey)` was already queued. */
  | { enqueued: false; reason: "duplicate" };

/**
 * Adds a run to the queue, dropping an exact duplicate.
 *
 * ⚠️ **The dedup here is an OPTIMIZATION, not the guarantee.** It saves a
 * duplicate the cost of a claim. The actual guarantee is unchanged and lives
 * where it does today: the `@@unique([workflowId, idempotencyKey])` constraint
 * on `Execution`, which the worker re-checks before creating anything. That one
 * is not going anywhere; this one is not permanent, and must not be allowed to
 * tempt anyone into removing the execution-level check.
 *
 * ⚠️ **`WorkflowJob` has no retention yet** (parent plan §9.8 — it belongs in
 * `pruneOldExecutions`, which Step 3 is not allowed to touch), so today these
 * rows outlive the `Execution` rows they mirror, which are deleted at 30 days.
 * Two consequences until it is built: the table grows without bound, and a key
 * re-sent more than 30 days later is dropped HERE while the Inngest path — whose
 * only dedup is that deleted `Execution` — would run it. **The retention window
 * for SUCCEEDED jobs must therefore be shorter than `Execution`'s 30 days, not
 * longer**, or the two runtimes disagree about the same input.
 *
 * The `idempotencyKey` COLUMN is derived from the payload rather than passed
 * separately, so the row and the payload cannot disagree about what this run
 * is deduplicated on.
 *
 * Nulls are distinct in Postgres, so the many keyless runs (manual `execute`,
 * `rerun`, `replayFromNode`) never collide with each other — matching the
 * behaviour of `Execution`'s own constraint.
 */
export async function enqueueWorkflowJob({
  workflowId,
  payload,
  maxAttempts = resolveWorkflowRetries() + 1,
  client = prisma,
}: {
  workflowId: string;
  payload: WorkflowExecutionPayload;
  /**
   * Total claims allowed, retries + the first attempt. Defaults to the same
   * policy the Inngest path uses, so a workflow does not change how hard it
   * tries by changing runtime. Injectable for tests.
   */
  maxAttempts?: number;
  client?: SqlRunner;
}): Promise<EnqueueResult> {
  // `@default(cuid())` is applied by the Prisma CLIENT, not by the database, so
  // a raw INSERT has to bring its own id. Same for `updatedAt`: `@updatedAt` is
  // client-side too, and the column is NOT NULL with no default, so omitting it
  // fails the insert outright.
  const id = createId();
  const idempotencyKey = payload.idempotencyKey ?? null;

  const rows = await client.$queryRaw<{ id: string }[]>`
    INSERT INTO "WorkflowJob" (
      "id", "workflowId", "payload", "idempotencyKey",
      "maxAttempts", "runAt", "createdAt", "updatedAt"
    )
    VALUES (
      ${id}, ${workflowId}, ${JSON.stringify(payload)}::jsonb, ${idempotencyKey},
      ${maxAttempts}, now(), now(), now()
    )
    ON CONFLICT ("workflowId", "idempotencyKey") DO NOTHING
    RETURNING "id"
  `;

  // No row means the conflict arm fired: something with this key is already
  // queued. Deliberately NOT the read-back that `insertStepResultOrReadExisting`
  // needs — that one must return the STORED value, so a snapshot race returning
  // nothing would be a wrong answer there. Here the only question is "did this
  // insert", and "no" is the correct and complete answer to it either way.
  if (rows.length === 0) return { enqueued: false, reason: "duplicate" };
  return { enqueued: true, jobId: rows[0].id };
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/**
 * Takes the next runnable job, or returns `null` when there is nothing to do.
 *
 * `attempt` is incremented HERE, on the claim, rather than on failure. A job
 * that reliably kills its worker — an OOM on a huge context, a native crash in
 * the QuickJS sandbox — never reaches a failure path at all, so counting only
 * clean failures would let it loop forever. Counting claims makes the poison-job
 * case terminate.
 *
 * ⚠️ **Each attempt is its own transaction, and that is load-bearing.** A unique
 * violation ABORTS the surrounding Postgres transaction: every later statement
 * in it fails with `25P02 current transaction is aborted, commands ignored until
 * end of transaction block`. So "catch the conflict and try again" cannot be a
 * loop inside one transaction — the second iteration would return a database
 * fault instead of a job. The loop below is safe precisely because it is NOT
 * wrapped in `$transaction`: each `$queryRaw` is its own implicit transaction,
 * and the claim is a single statement, so nothing needs to span them. This works
 * perfectly until two workers actually collide, which is why it is written down.
 */
export async function claimNextJob({
  workerId,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  maxConflictRetries = MAX_CLAIM_CONFLICT_RETRIES,
  client = prisma,
}: {
  /** Identifies this worker instance; stored on the row as `lockedBy`. */
  workerId: string;
  leaseSeconds?: number;
  maxConflictRetries?: number;
  client?: SqlRunner;
}): Promise<WorkflowJob | null> {
  for (let attempt = 0; attempt <= maxConflictRetries; attempt++) {
    try {
      const rows = await client.$queryRaw<WorkflowJob[]>`
        UPDATE "WorkflowJob" j
        SET status = 'RUNNING'::"JobStatus",
            "lockedBy" = ${workerId},
            "leaseExpiresAt" = now() + (${leaseSeconds}::int * interval '1 second'),
            attempt = j.attempt + 1,
            "updatedAt" = now()
        WHERE j.id = (
          SELECT c.id FROM "WorkflowJob" c
          WHERE c.status = 'PENDING'
            AND c."runAt" <= now()
            AND NOT EXISTS (
              SELECT 1 FROM "WorkflowJob" r
              WHERE r."workflowId" = c."workflowId" AND r.status = 'RUNNING'
            )
          -- FIFO, and runAt first so a backed-off retry waits its turn rather
          -- than jumping the queue on createdAt. The fan-out chain and burst
          -- triggers both assume this order.
          ORDER BY c."runAt", c."createdAt", c.id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING j.*
      `;
      return rows[0] ?? null;
    } catch (error) {
      if (!isRunningJobConflict(error)) throw error;
      // Another worker won this workflow between our SELECT and our UPDATE. Not
      // an error: loop round and look for a different workflow's job.
      countClaimConflict();
    }
  }

  // Out of retries. Returning null (rather than throwing) says "nothing was
  // claimed", which is exactly what the caller does about it either way.
  return null;
}

/**
 * True for the per-workflow concurrency violation — i.e. "that workflow is
 * already running", the one error the claim treats as ordinary contention.
 *
 * ⚠️ **The constraint NAME is not available, so this cannot check for it.**
 * Verified against a real Postgres through this exact code path: Prisma reports
 * a raw-query unique violation as `P2010` (NOT `P2002`, which is the QUERY
 * BUILDER's mapping) with `meta.code = "23505"` and
 * `meta.message = 'Key ("workflowId")=(…) already exists.'`. Postgres' detail
 * names the conflicting KEY COLUMNS; `WorkflowJob_one_running_per_workflow`
 * appears nowhere in the error.
 *
 * So the discriminator is the column list, and it is exact rather than
 * approximate: this table's other unique indexes are on `("executionId")` and
 * on `("workflowId", "idempotencyKey")`, and the latter renders as
 * `("workflowId", "idempotencyKey")=`, which does not match the pattern below.
 *
 * ⚠️ The pattern matches ONLY the identifier fragment, never the surrounding
 * words. Postgres translates its messages — that detail reads `Key (…) already
 * exists` under English `lc_messages` and `Schlüssel »(…)« existiert bereits`
 * under German — so anchoring on the word "Key" would turn ordinary contention
 * into a hard error on any server with a localized message catalogue. The
 * quoted column names and the `=` survive translation; nothing else does.
 *
 * Both Prisma shapes are handled because the two differ only in HOW the claim is
 * written, not in what happened — if it is ever rewritten with the query builder
 * this keeps working. Anything else rethrows: a unique violation we cannot
 * positively identify as this one is a real fault, and swallowing it as
 * contention would retry a broken statement forever.
 */
function isRunningJobConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, meta } = error as {
    code?: string;
    meta?: { code?: string; message?: string; target?: unknown };
  };

  // Raw path (what the claim above produces).
  if (code === "P2010" && meta?.code === "23505") {
    return /\("workflowId"\)=/.test(meta.message ?? "");
  }
  // Query-builder path, kept for a future rewrite: `target` is the field list.
  if (code === "P2002") {
    const target = meta?.target;
    return (
      Array.isArray(target) && target.length === 1 && target[0] === "workflowId"
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Holding the job: heartbeat, and the queue half of fencing
// ---------------------------------------------------------------------------

/**
 * Why a heartbeat found nothing to renew. All three end this worker's run; they
 * are named apart so the log line points at the right problem.
 */
export type HeartbeatLossReason =
  /** The row is still RUNNING, but somebody else owns it now. */
  | "lease-stolen"
  /**
   * The row is gone. `WorkflowJob.workflow` is `onDelete: Cascade`, so deleting
   * a workflow while one of its jobs is RUNNING removes it out from under the
   * worker — which SHOULD stop the run, and does, but as an infrastructure
   * fault unless it is named.
   */
  | "job-row-gone"
  /**
   * The row exists and is still ours, but is no longer RUNNING — the reaper
   * returned it to PENDING, or it was cancelled. The work is somebody else's
   * now (or nobody's) either way.
   */
  | "not-running";

export type HeartbeatResult =
  | { held: true; leaseExpiresAt: Date }
  | { held: false; reason: HeartbeatLossReason };

/**
 * Renews the lease, and reports honestly when it cannot.
 *
 * **Zero rows updated means this worker has been fenced and must stop.** That is
 * the whole point of the function: without it, reclaim manufactures the one
 * failure the design forbids — two processes running one execution, both
 * appending rows to a client's spreadsheet.
 *
 * This module reports the loss; turning it into an abort belongs to the worker.
 * `FencedError` is deliberately not imported here: it lives in `src/worker/`
 * because `src/queue/` is shared with the Next app, which has no business
 * carrying a worker-abort class.
 */
export async function heartbeatJob({
  jobId,
  workerId,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  client = prisma,
}: {
  jobId: string;
  workerId: string;
  leaseSeconds?: number;
  client?: SqlRunner;
}): Promise<HeartbeatResult> {
  const rows = await client.$queryRaw<{ leaseExpiresAt: Date }[]>`
    UPDATE "WorkflowJob"
    SET "leaseExpiresAt" = now() + (${leaseSeconds}::int * interval '1 second'),
        "updatedAt" = now()
    WHERE ${heldBy(jobId, workerId)}
    RETURNING "leaseExpiresAt"
  `;

  if (rows[0]) return { held: true, leaseExpiresAt: rows[0].leaseExpiresAt };

  const reason = await diagnoseLostLease(jobId, workerId, client);
  countFence(reason);
  return { held: false, reason };
}

/**
 * Which of the three predicates failed, for the log line.
 *
 * Costs a query only on the failing path. It is DIAGNOSTIC, not authoritative:
 * the row can change again between the update above and this read, so a
 * `lease-stolen` that was momentarily `not-running` is possible. The outcome
 * does not depend on which it says — the worker aborts either way — so a
 * best-effort answer is the right trade against holding a lock to get a perfect
 * one.
 *
 * ⚠️ **Raw, not `prisma.workflowJob.findUnique`, and that is not a style
 * choice.** This was the only model-delegate call in the module, and it sits on
 * the HEARTBEAT's failing path — the one call that must be able to run on the
 * worker's small control-plane pool while its runs saturate the execution pool.
 * A delegate cannot be reached through `SqlRunner`, so keeping it would have
 * forced that type wide enough to admit a whole `PrismaClient`. One indexed
 * single-row SELECT in the style of every other statement here was the cheaper
 * end of that trade.
 */
async function diagnoseLostLease(
  jobId: string,
  workerId: string,
  client: SqlRunner,
): Promise<HeartbeatLossReason> {
  const rows = await client.$queryRaw<{ lockedBy: string | null }[]>`
    SELECT "lockedBy" FROM "WorkflowJob" WHERE id = ${jobId}
  `;

  const row = rows[0];
  if (!row) return "job-row-gone";

  // ⚠️ **A NULL `lockedBy` is NOT a stolen lease, and reading it as one made
  // `not-running` unreachable.** Every release path in this module — the
  // reaper, `failJob`, `completeJob` — clears `lockedBy` in the same statement
  // that changes the status. So a plain `lockedBy !== workerId` test answers
  // "lease-stolen" for a reaper reclaim, which is the single most likely reason
  // a heartbeat ever fails, and the honest `not-running` answer could only be
  // produced by a row state nothing in the codebase writes.
  //
  // That mattered because the distinction is the whole reason the third reason
  // exists: `lease-stolen` sends an operator after a host or lease-length
  // problem, and a reclaim is neither.
  if (row.lockedBy === null) return "not-running";
  if (row.lockedBy !== workerId) return "lease-stolen";
  // Still ours, so the status clause is what failed: cancelled, or reclaimed
  // and re-claimed by this same worker.
  return "not-running";
}

/**
 * Records which `Execution` this job produced, as soon as that row exists.
 *
 * Call it at CREATION time, not at completion. A failure between "the execution
 * row exists" and "the run finished" otherwise has nowhere to be recorded, which
 * is exactly the gap Inngest's `onFailure` has today: it addresses rows by
 * `inngestEventId`, so a failure before the row exists is invisible. Holding the
 * id on the job row from the start is what closes that, and it doubles as the
 * correlation id between a queue row and a run.
 *
 * Ownership-guarded like every other transition here: a fenced worker must not
 * be able to write anything onto a job another worker now owns.
 *
 * Returns whether it took effect, which is `false` exactly when this worker no
 * longer holds the job.
 */
export async function attachExecutionToJob({
  jobId,
  workerId,
  executionId,
  client = prisma,
}: {
  jobId: string;
  workerId: string;
  executionId: string;
  client?: SqlRunner;
}): Promise<boolean> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    UPDATE "WorkflowJob"
    SET "executionId" = ${executionId},
        "updatedAt" = now()
    WHERE ${heldBy(jobId, workerId)}
    RETURNING "id"
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Finishing: complete, fail
// ---------------------------------------------------------------------------

/**
 * Marks the run done and releases the lease.
 *
 * Guarded on ownership for the same reason as everything else: a worker that was
 * fenced mid-run and then finished its last step must not mark SUCCEEDED a job
 * that another worker is at that moment executing. `false` means "you no longer
 * own this" — the caller should abandon quietly, not report an outcome.
 */
export async function completeJob({
  jobId,
  workerId,
  client = prisma,
}: {
  jobId: string;
  workerId: string;
  client?: SqlRunner;
}): Promise<boolean> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    UPDATE "WorkflowJob"
    SET status = 'SUCCEEDED'::"JobStatus",
        "lockedBy" = NULL,
        "leaseExpiresAt" = NULL,
        -- Cleared, because it describes an attempt that no longer decides
        -- anything. A job that failed once and then succeeded would otherwise
        -- sit SUCCEEDED with a populated lastError forever, and every list view
        -- or support query that reads that column as "is this broken" would
        -- call a healthy run broken. The attempt count still records that it
        -- took more than one go, which is the part worth keeping.
        "lastError" = NULL,
        "updatedAt" = now()
    WHERE ${heldBy(jobId, workerId)}
    RETURNING "id"
  `;
  return rows.length > 0;
}

export type FailResult =
  | { outcome: "retry-scheduled"; runAt: Date; delayMs: number }
  /** Attempts are spent; the job is FAILED and will not run again. */
  | { outcome: "exhausted" }
  /** This worker no longer holds the job — fenced. Nothing was written. */
  | { outcome: "not-owned" };

/**
 * Records a failed attempt, and decides what happens next.
 *
 * Three error classes, three behaviours — and the middle one is not optional:
 *
 * | class               | behaviour                                        |
 * |---------------------|--------------------------------------------------|
 * | `NonRetriableError` | fail now, and spend the remaining attempts        |
 * | `RetryAfterError`   | wait at least as long as the provider asked       |
 * | anything else       | ordinary backoff                                  |
 *
 * `RetryAfterError` is how Google's and Microsoft's rate limits are respected.
 * Ignoring it aims our retry storm at a client's Sheets quota, and it is easy to
 * miss because only four sites in the codebase produce one.
 *
 * ⚠️ `http.ts` sets `retry: 0` on the background HTTP client with the comment
 * "INSIDE A STEP, INNGEST OWNS RETRYING". On the worker, THIS function is what
 * that comment is deferring to. If it stops retrying, every outbound call in the
 * system silently has no retries at all.
 *
 * The attempt count comes from the CLAIMED ROW rather than being re-read. That
 * is safe because of the ownership guard, not in spite of it: the only thing
 * that changes `attempt` behind our back is a reclaim, and a reclaim clears
 * `lockedBy`, so the update below matches nothing and returns `not-owned`. A
 * stale count can never be applied.
 */
export async function failJob({
  job,
  workerId,
  error,
  random = Math.random,
  client = prisma,
}: {
  job: Pick<WorkflowJob, "id" | "attempt" | "maxAttempts">;
  workerId: string;
  error: unknown;
  /** Injectable jitter, so the backoff schedule can be asserted exactly. */
  random?: () => number;
  client?: SqlRunner;
}): Promise<FailResult> {
  const message = failureMessage(error);

  // A deliberate "never retry this" spends the remaining attempts rather than
  // merely stopping, so the row reads honestly: attempt 1 of 4 next to status
  // FAILED looks like a queue that forgot to retry.
  const nonRetriable = isNonRetriableError(error);
  const terminal = nonRetriable || job.attempt >= job.maxAttempts;
  const attempt = nonRetriable ? job.maxAttempts : job.attempt;

  const delayMs = terminal ? 0 : nextDelayMs(job.attempt, error, random);

  const rows = await client.$queryRaw<{ status: string; runAt: Date }[]>`
    UPDATE "WorkflowJob"
    SET status = ${terminal ? "FAILED" : "PENDING"}::"JobStatus",
        attempt = ${attempt},
        -- Computed by POSTGRES, from Postgres' clock. Every other time
        -- comparison in this module (runAt <= now(), leaseExpiresAt, the
        -- reaper) uses the server's clock, and mixing a worker-side new Date()
        -- into that would make "did this job run on time" depend on the
        -- container's clock agreeing with the database's. Only the jitter is
        -- computed in JS.
        "runAt" = CASE
          WHEN ${terminal}::boolean
          THEN "runAt"
          ELSE now() + (${delayMs}::int * interval '1 millisecond')
        END,
        "lockedBy" = NULL,
        "leaseExpiresAt" = NULL,
        "lastError" = ${message},
        "updatedAt" = now()
    WHERE ${heldBy(job.id, workerId)}
    RETURNING status::text AS "status", "runAt"
  `;

  if (rows.length === 0) return { outcome: "not-owned" };
  if (terminal) return { outcome: "exhausted" };
  return { outcome: "retry-scheduled", runAt: rows[0].runAt, delayMs };
}

/**
 * The stored form of a failure's message: bounded, and legal as Postgres `text`.
 *
 * ⚠️ The NUL strip is not defensive tidiness. Postgres rejects `\u0000` in a
 * `text` value outright, so an error message carrying one — a binary response
 * fragment, a Code node returning sandbox output — would make `failJob`'s own
 * UPDATE throw. That failure lands while HANDLING a failure, so nothing catches
 * it: the job stays RUNNING with its lease held and no error recorded, until the
 * reaper takes it and re-runs every side effect the step store did not memoize.
 * One strip buys the whole failure path.
 *
 * `replaceAll` with a plain string rather than a `/\u0000/g` regex: a regex
 * carrying a control character is linted against, rightly, in general.
 */
function failureMessage(error: unknown): string {
  const raw = (
    error instanceof Error ? error.message : String(error)
  ).replaceAll("\u0000", "");
  return raw.length > MAX_LAST_ERROR_CHARS
    ? `${raw.slice(0, MAX_LAST_ERROR_CHARS)}…`
    : raw;
}

/**
 * Exponential backoff with FULL jitter, floored at whatever the provider asked
 * for.
 *
 * ```
 * delay = random(0, min(CAP, BASE * 2^(attempt - 1)))
 * ```
 *
 * Full jitter rather than equal jitter because a provider outage fails many
 * workflows at once, and they must not resynchronise into a thundering herd when
 * it recovers. A 10 s base rather than an immediate retry because run failures
 * are overwhelmingly third-party blips and rate limits, and an instant retry
 * re-hits the same limit. Matching Inngest's exact schedule is explicitly not a
 * goal — our retries are cheap, since a resumed run does not re-execute its
 * completed steps.
 *
 * A `RetryAfterError` raises the floor but never lowers it: `Math.max`, not a
 * replacement. Obeying a provider's "come back in 1 s" as an upper bound would
 * turn a rate limit into a tight loop against it.
 */
function nextDelayMs(
  attempt: number,
  error: unknown,
  random: () => number,
): number {
  const backoff = computeBackoffMs(attempt, random);
  if (!isRetryAfterError(error)) return backoff;
  const asked = parseRetryAfterMs(error.retryAfter);
  return asked === null ? backoff : Math.max(asked, backoff);
}

/** The jittered exponential delay for the attempt that just failed. */
export function computeBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  // `2 ** huge` is Infinity, which `Math.min` resolves to CAP — so a job with an
  // absurd attempt count degrades to the ceiling rather than to NaN.
  const ceiling = Math.min(
    RETRY_CAP_MS,
    RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(random() * ceiling);
}

/**
 * Reads `RetryAfterError.retryAfter`, which is a string in two different
 * languages, or `null` when it is neither.
 *
 * ⚠️ Verified against the installed SDK, because its own doc comment is WRONG
 * about this: it says "a number of milliseconds or a RFC3339 date", while the
 * constructor stores `Math.ceil(ms / 1000)` — **seconds**. Reading the `.d.ts`
 * and believing it would make every rate-limit wait 1000× too short.
 *
 * So: if it parses as a finite number it is SECONDS; otherwise it is a date. All
 * four producers in this codebase pass `ms`-style strings (`"30s"`), which the
 * SDK converts to seconds, so the date branch is defensive rather than
 * exercised.
 *
 * The date branch is the one place a worker-side clock enters the schedule,
 * unavoidably: an absolute instant has to be turned into a duration before
 * Postgres can add it to `now()`.
 */
export function parseRetryAfterMs(
  retryAfter: string,
  nowMs: number = Date.now(),
): number | null {
  const raw = retryAfter.trim();
  if (raw === "") return null;

  // `Number("")` is 0, which is why the empty check is above rather than folded
  // into this one — an empty string must not become "retry immediately".
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

// ---------------------------------------------------------------------------
// Reclaim
// ---------------------------------------------------------------------------

/**
 * The `lastError` written when a job is killed by the reaper rather than by a
 * failure. Nothing else can describe this run: the worker that was executing it
 * never got to report anything.
 *
 * ⚠️ Exported because the run's `Execution.error` — and therefore the alert
 * email the user actually reads — must say the SAME thing as the job row. They
 * are written by different processes at different layers (this module writes
 * `lastError`; the worker's reaper tick settles the execution), and a second
 * copy of these sentences would let one event tell the user two stories.
 */
export const POISON_JOB_ERROR =
  "This run was stopped because the worker executing it stopped responding " +
  "once for every attempt it had. That usually means the run is killing its " +
  "worker outright — an out-of-memory on a very large context, or a crash " +
  "inside the Code node's sandbox — rather than failing normally.";

/**
 * A job the reaper gave up on, with everything needed to settle the RUN it was
 * executing — see `ReclaimResult.exhausted` for why the caller must.
 */
export type ExhaustedJob = {
  id: string;
  /**
   * The run this job produced, or `null` when it died before
   * `attachExecutionToJob` fired. Null means there is no `Execution` row to
   * settle and the job row's `lastError` is the whole record.
   */
  executionId: string | null;
  workflowId: string;
  /** Carried because the fan-out chain the settle must advance lives in it. */
  payload: WorkflowExecutionPayload;
};

export type ReclaimResult = {
  /** Lease losses returned to the queue, resumable from their stored steps. */
  reclaimed: number;
  /**
   * Lease losses that had no attempts left and were marked FAILED.
   *
   * ⚠️ **The caller MUST settle each one's `Execution` row** — with
   * `settleFailedExecution`, exactly as it would for a job `failJob` exhausted.
   * Returning the rows rather than a count is what makes that possible, and it
   * closes a hole that is invisible from inside this module: marking the JOB
   * FAILED says nothing to the `Execution` row, so a job that kills its worker
   * on every attempt would otherwise leave the user's run reading RUNNING
   * forever, with no failure email, and any fan-out chain it held silently
   * dropping every remaining item. Nothing else can report that run — the
   * process that was executing it is gone.
   *
   * Settling is deliberately NOT done here. This module is pure functions over
   * rows and is imported by the Next app; `settleFailedExecution` pulls in
   * email, Sentry and the fan-out dispatcher.
   */
  exhausted: ExhaustedJob[];
};

/**
 * Takes back jobs whose lease has expired: most go back to PENDING for another
 * worker to resume, and the ones with no attempts left are marked FAILED.
 *
 * A reclaimed job keeps its `executionId` and its stored steps, so resuming is
 * a fast-forward rather than a restart — the engine runs from the top and every
 * completed `step.run` returns its stored value.
 *
 * ⚠️ **This function is the ONLY thing that terminates a poison job, and that is
 * not obvious.** `attempt` is incremented on claim specifically so a job that
 * kills its worker outright — an OOM on a huge context, a native crash in the
 * QuickJS sandbox — still runs out of attempts. But such a job never reaches
 * `failJob`, because nothing survives to call it: the process is gone. So
 * `failJob` cannot be the only place `maxAttempts` is enforced, or the cycle is
 * reclaim → claim → die → reclaim, forever, at reaper cadence. Worse than
 * forever: the partial unique index means that job holds its workflow's single
 * RUNNING slot on every pass, so one poison job starves every other run that
 * client has queued for that workflow.
 *
 * It is deliberately marked **FAILED rather than left PENDING-and-unclaimable**.
 * A row nobody will ever claim is the "silently stuck" state this whole module
 * exists to make impossible; FAILED with a `lastError` is a run the user can
 * see, and `failedInWindow` counts.
 *
 * ⚠️ **The refund arithmetic is the other half, and it is exactly the kind of
 * thing that looks obviously right and is off by one.** Claims and lease losses
 * must not share a counter: a rolling deploy, a long GC pause, a stalled
 * connection or a brief partition all end in a reclaim with ZERO genuine
 * failures, and at `maxAttempts = 4` a bad afternoon would exhaust a perfectly
 * healthy job. So a reclaim gives back the attempt it cost — but only for the
 * first `MAX_FREE_RECLAIMS` of them, which is what leaves the paragraph above
 * able to terminate.
 *
 * The CASE reads the row's PRE-UPDATE `reclaims`, so with `MAX_FREE_RECLAIMS = 2`
 * the 1st reclaim (`reclaims` 0) and the 2nd (`reclaims` 1) refund, and the 3rd
 * (`reclaims` 2) does not.
 *
 * The claim query deliberately does NOT also filter on `attempt < maxAttempts`.
 * With this function correct, no PENDING row can have spent attempts — and if
 * some future writer produced one, running it once more is a better failure than
 * hiding it from every worker forever.
 */
export async function reclaimExpiredJobs({
  limit = 50,
  client = prisma,
}: {
  limit?: number;
  client?: SqlRunner;
} = {}): Promise<ReclaimResult> {
  const rows = await client.$queryRaw<
    {
      status: string;
      id: string;
      executionId: string | null;
      workflowId: string;
      payload: WorkflowExecutionPayload | null;
    }[]
  >`
    WITH expired AS (
      SELECT
        c.id,
        -- Computed once, here, because the UPDATE needs it twice: to write it,
        -- and to decide whether what remains is enough to run again.
        CASE
          WHEN c.reclaims < ${MAX_FREE_RECLAIMS}
          THEN GREATEST(c.attempt - 1, 0)
          ELSE c.attempt
        END AS next_attempt
      FROM "WorkflowJob" c
      WHERE c.status = 'RUNNING'
        -- A RUNNING row with no lease at all cannot be renewed by anyone and
        -- would otherwise be stuck forever; NULL < now() is NULL, so it needs
        -- saying explicitly. The claim always sets a lease, so this is a
        -- guard against a future writer, not against a path that exists today.
        AND (c."leaseExpiresAt" IS NULL OR c."leaseExpiresAt" < now())
      -- NULLS FIRST is load-bearing, not tidiness: Postgres sorts NULLs LAST by
      -- default, so without it the lease-less rows the WHERE clause above goes
      -- out of its way to rescue would sort behind every expired-lease row and
      -- never fit inside the batch limit under a backlog — stuck forever, which
      -- is the exact state the guard was added to prevent.
      ORDER BY c."leaseExpiresAt" NULLS FIRST
      -- Bounded so one reaper tick cannot turn into an unbounded write, and
      -- SKIP LOCKED so two reapers never block on each other.
      LIMIT ${limit}::int
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "WorkflowJob" j
    SET status = CASE
          WHEN e.next_attempt >= j."maxAttempts"
          THEN 'FAILED'
          ELSE 'PENDING'
        END::"JobStatus",
        reclaims = j.reclaims + 1,
        attempt = e.next_attempt,
        "lockedBy" = NULL,
        "leaseExpiresAt" = NULL,
        -- Immediately claimable. A reclaim is infrastructure noise, not a
        -- failure, so surviving work should not also be delayed by a backoff it
        -- did not earn.
        "runAt" = now(),
        "lastError" = CASE
          WHEN e.next_attempt >= j."maxAttempts"
          THEN ${POISON_JOB_ERROR}
          ELSE j."lastError"
        END,
        "updatedAt" = now()
    FROM expired e
    WHERE j.id = e.id
    -- Every reference here is to the NEW row, so the status below is the one
    -- the CASE above just decided.
    RETURNING
      j.status::text AS "status",
      j.id AS "id",
      j."executionId" AS "executionId",
      j."workflowId" AS "workflowId",
      -- Only the caller's settle needs a payload, and only exhausted rows get
      -- settled. Shipping every reclaimed row's payload would put the common
      -- case (a rolling deploy reclaims everything in flight) on the wire
      -- forever to serve the rare one.
      CASE WHEN j.status = 'FAILED' THEN j.payload ELSE NULL END AS "payload"
  `;

  // Both outcomes lost a lease, so both count as reclaims — that counter is the
  // "is the worker host healthy" signal and a death is not less of a symptom
  // than a handover.
  if (rows.length > 0) countReclaims(rows.length);

  const exhausted = rows
    .filter((row) => row.status === "FAILED")
    .map(({ id, executionId, workflowId, payload }) => ({
      id,
      executionId,
      workflowId,
      // `?? {}` rather than a non-null assertion: the CASE guarantees a payload
      // on exactly these rows, but that guarantee lives in SQL where no type
      // checks it, and an empty payload settles correctly (no chain to advance).
      payload: payload ?? {},
    }));
  return { reclaimed: rows.length - exhausted.length, exhausted };
}
