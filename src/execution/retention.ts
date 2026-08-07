/**
 * How long each kind of run record is kept.
 *
 * These live together, in one file with no imports, because the important fact
 * about them is a RELATIONSHIP rather than any individual number — and a
 * relationship split across two modules is one nobody checks.
 *
 * ## The invariant
 *
 * **`SUCCEEDED_JOB_RETENTION_DAYS` must stay strictly less than
 * `EXECUTION_RETENTION_DAYS`.** Not a tidiness preference — get it backwards and
 * the two runtimes disagree about the same input.
 *
 * Deduplication happens at two levels (parent plan §2.5). `WorkflowJob` carries
 * `@@unique([workflowId, idempotencyKey])`, which drops a duplicate before it
 * costs a claim; `Execution` carries the same constraint, and THAT one is the
 * actual guarantee. So while a job row survives, its key is deduplicated by the
 * queue. Let a SUCCEEDED job outlive the `Execution` it produced and a key
 * re-sent in the gap is **dropped by the worker but run by Inngest** — the same
 * external event handled differently depending only on which runtime the
 * workflow happens to be routed to, which is precisely the divergence this
 * migration is supposed to be free of.
 *
 * Shorter is always safe: pruning a job row merely gives up an optimisation,
 * because `Execution`'s constraint still holds for the full 30 days.
 *
 * `pruneWorkflowJobs` (src/queue/jobs.ts) applies these; `retention.test.ts`
 * asserts the inequality rather than trusting the two numbers to be read
 * together.
 */

/**
 * How long `Execution` rows (and everything cascading from them — `StepResult`,
 * `NodeExecution`, `NodeInputSnapshot`, `FanOutSource`/`FanOutItem`) are kept.
 * Applied by `pruneOldExecutions` in src/inngest/functions.ts.
 */
export const EXECUTION_RETENTION_DAYS = 30;

/**
 * How long a finished-cleanly job row is kept. Short on purpose: it holds no
 * information the `Execution` row does not, and every day it survives past
 * `EXECUTION_RETENTION_DAYS` would be a day the two runtimes disagree.
 */
export const SUCCEEDED_JOB_RETENTION_DAYS = 7;

/**
 * How long a job row that exhausted its attempts is kept.
 *
 * Derived from `EXECUTION_RETENTION_DAYS` rather than written as its own
 * literal, so the relationship survives someone editing that number — but
 * **one day SHORTER, and the margin is load-bearing, not padding.**
 *
 * An earlier revision set the two equal, reasoning that a FAILED job and its
 * FAILED `Execution` should expire together. They do not, because **the two
 * windows are measured from different anchors**: `pruneOldExecutions` compares
 * `Execution.startedAt`, while `pruneWorkflowJobs` compares
 * `WorkflowJob.updatedAt` — the moment the job reached its terminal status,
 * which is necessarily LATER, by however long the run took plus every backoff
 * and reclaim before it gave up. Equal numbers against unequal anchors mean the
 * job routinely outlives the execution, and a once-daily cron rounds that up to
 * a whole extra day.
 *
 * In that window the FAILED job row is the ONLY holder of
 * `(workflowId, idempotencyKey)` — which is precisely the cross-runtime
 * divergence the top of this file says must not happen: a re-sent
 * `gmail:<messageId>` dropped by the worker's enqueue and run by Inngest.
 *
 * A day comfortably exceeds any run-plus-backoff span (`RETRY_CAP_MS` is five
 * minutes and `maxAttempts` is single digits) and absorbs the cron's
 * granularity. The row is worth keeping at all because `lastError` is the only
 * record of why the run never started.
 */
export const FAILED_JOB_RETENTION_DAYS = EXECUTION_RETENTION_DAYS - 1;

/**
 * How long a cancelled job row is kept. Deliberately the SHORT window, and for
 * a different reason from the others.
 *
 * A cancelled job is one that never ran, so — unlike SUCCEEDED and FAILED — it
 * has **no `Execution` row beside it**. Nothing else anywhere holds its
 * idempotency key, so for as long as the row lives it is the only thing
 * deduplicating that key, and a re-sent external event would be silently
 * dropped by the queue while Inngest would run it.
 *
 * The rollback runbook in DEPLOYMENT.md closes that gap properly, by nulling
 * `idempotencyKey` as it cancels — the payload keeps the original for
 * forensics, and NULLs are distinct in Postgres, so the dedup slot is released
 * immediately. This short window is the backstop for any cancelled row that
 * reaches the table another way.
 */
export const CANCELLED_JOB_RETENTION_DAYS = 7;
