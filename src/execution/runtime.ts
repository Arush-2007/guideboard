import type { ExecutionRuntime } from "@/generated/prisma";

/**
 * Which engine executes a run, as it travels on the wire.
 *
 * Two spellings of this exist and they are not interchangeable, so this module
 * is where the difference is resolved once:
 *
 * - **`ExecutionRuntime`** (Prisma) — `INNGEST` | `WORKER`. The stored
 *   `Workflow.executionRuntime` column, uppercase because that is the
 *   convention for a Postgres enum.
 * - **`ExecutionRuntimeName`** (below) — `"inngest"` | `"worker"`. What the
 *   routing seam returns and what `FanOutChain.runtime` carries inside a JSON
 *   payload, lowercase because §7.1 of the parent plan specified the seam that
 *   way and because it is read in logs.
 *
 * Keeping both is deliberate; keeping two CONVERSIONS between them is not.
 * `runtimeNameFromColumn` is the only translation, so a third runtime added
 * later has exactly one place to be spelled.
 *
 * ⚠️ This module deliberately has no runtime imports — the Prisma import above
 * is `import type` and is erased. It is reached from `src/inngest/fan-out.ts`,
 * which is in the WORKER's import graph, and the seam that consumes it
 * (`src/inngest/utils.ts`) constructs the Inngest client at module load. Were
 * this vocabulary defined there instead, `fan-out.ts` would import it and every
 * consumer of the fan-out types would be one careless `import type` → `import`
 * away from building an Inngest client inside the worker — the same hazard
 * `src/execution/payload.ts` documents for the payload shape.
 */
export type ExecutionRuntimeName = "inngest" | "worker";

/**
 * The stored column as a wire name. **NULL means Inngest**, which is the whole
 * safety property of the rollout: every workflow that predates the self-hosted
 * worker has NULL here, so an unset column can never silently move live traffic
 * onto new machinery.
 *
 * `INNGEST` maps to the same answer as NULL today. It exists so a workflow can
 * be pinned deliberately once the default flips, at which point "never
 * migrated" and "migrated, then rolled back on purpose" stop being the same
 * fact — see the enum's comment in the schema.
 */
export function runtimeNameFromColumn(
  value: ExecutionRuntime | null | undefined,
): ExecutionRuntimeName {
  return value === "WORKER" ? "worker" : "inngest";
}

/**
 * The one spelling of the worker's synthetic-event-id prefix. Private: both
 * sides of the contract go through the two functions below, so no caller has to
 * know the format at all.
 */
const WORKER_EVENT_ID_PREFIX = "job_";

/**
 * `Execution.inngestEventId` for a worker run.
 *
 * That column is `String @unique` and NOT NULL, but a worker run has no Inngest
 * event — so the worker writes a synthetic id derived from its job. It is
 * globally unique, needs no schema change, doubles as the correlation id from a
 * run back to its queue row, and is **stable across every attempt of one job**,
 * which is what lets `create-execution`'s upsert adopt the row a crashed
 * attempt left behind instead of stranding the job on the unique constraint.
 *
 * ⚠️ **The prefix is a two-sided contract, which is why it is a function rather
 * than a string literal at each end.** `run-job.ts` writes it; the routing seam
 * READS it, to decide which runtime ran a fan-out's parent (see
 * `isWorkerEventId`). Spelled as a bare `"job_"` in both places, the id scheme
 * could change on the writing side with nothing — no compiler error, no grep
 * hit — pointing at the reader that silently depends on it.
 */
export function workerEventId(jobId: string): string {
  return `${WORKER_EVENT_ID_PREFIX}${jobId}`;
}

/**
 * Whether an `Execution.inngestEventId` names a worker run rather than an
 * Inngest one. The inverse of `workerEventId`, and the reason that function
 * exists: this is an authoritative record of what actually RAN, as opposed to
 * what `Workflow.executionRuntime` currently says should run.
 */
export function isWorkerEventId(inngestEventId: string): boolean {
  return inngestEventId.startsWith(WORKER_EVENT_ID_PREFIX);
}
