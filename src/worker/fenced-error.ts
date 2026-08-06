/**
 * Thrown when this worker no longer owns the execution it is running.
 *
 * A worker holds a job through a LEASE, not a held transaction, and renews it
 * with a heartbeat. When a heartbeat's UPDATE affects zero rows the lease is
 * gone — reclaimed by the reaper after a network partition, a long GC pause or
 * a stalled DB connection — and some OTHER worker is now executing this same
 * execution. This process must stop touching the world immediately. Without
 * that, reclaim manufactures the one failure the whole design forbids: two
 * processes running one execution, both appending rows to a client's
 * spreadsheet.
 *
 * Deliberately zero imports. The heartbeat (which discovers a fence) and the
 * step factory (which enforces one) live in different modules and neither
 * should have to pull the other in just to name this condition — and with no
 * imports at all, nothing can form a cycle with it.
 *
 * ⚠️ TWO RULES FOR WHOEVER CATCHES THIS. Both are the fencing bug reappearing
 * one layer up if broken:
 *
 * 1. **It must not be treated as a job failure.** A fenced worker does not own
 *    the job any more, so falling through to the generic "mark the execution
 *    FAILED" path marks failed a run that another worker is at that moment
 *    executing successfully. Catch it BEFORE the generic failure handler and
 *    abandon the run quietly — the holder of the lease owns the outcome.
 *
 * 2. **It deliberately does NOT extend `NonRetriableError`.** Being fenced says
 *    nothing about whether the work is retriable; it says this process is no
 *    longer the one doing it. Marking it non-retriable would let a lease
 *    handover masquerade as a permanent config failure.
 */

/**
 * Why the fence fired. All of these end the run identically — the distinction
 * exists so the log line is honest about which happened, because they point at
 * different problems: a stolen lease means the worker host is unhealthy (or the
 * lease is too short), a vanished job row means the workflow was deleted
 * mid-run, and a job no longer RUNNING means the reaper (or a cancel) took it.
 *
 * ⚠️ **Every `HeartbeatLossReason` (`src/queue/jobs.ts`) has an identically
 * named member here**, so the mapping between the two is the IDENTITY and there
 * is no translation table to get wrong. They are restated rather than imported
 * because this module has zero imports on purpose — see the header. A reason
 * added there needs adding here, and TypeScript will say so at the one place
 * that maps them.
 *
 * `lease-expired` is the exception, and deliberately so: it has no heartbeat
 * counterpart because it is concluded LOCALLY rather than reported by the row.
 */
export type FenceReason =
  /** The heartbeat matched no row: another worker reclaimed the lease. */
  | "lease-stolen"
  /**
   * The job row itself is gone. `WorkflowJob.workflow` is `onDelete: Cascade`,
   * so deleting a workflow while one of its jobs is RUNNING removes the row out
   * from under the worker. Aborting is the right outcome; naming it separately
   * is what stops it being misread as an infrastructure fault.
   */
  | "job-row-gone"
  /**
   * The row is still ours by `lockedBy` but is no longer RUNNING — the reaper
   * returned it to PENDING, or it was cancelled.
   *
   * Kept distinct rather than folded into `lease-stolen`, which was the
   * alternative: nothing was stolen here, and a log full of `lease-stolen`
   * during the first real incident would send whoever is reading it after a
   * lease-length problem that does not exist. It is also the reason
   * `CANCELLED` needs no fencing work of its own when cancellation lands — a
   * cancelled job's next heartbeat already reports exactly this.
   */
  | "not-running"
  /**
   * The worker could not REACH the database to renew for longer than a whole
   * lease, so it assumes the reaper has given the job to somebody else.
   *
   * The only reason here that nothing told the worker about. The other three
   * are answers; this one is a conclusion drawn from silence — and it is the
   * one that closes the hole an authoritative `held: false` cannot: while a
   * worker is partitioned from Postgres it receives no answers at all, and
   * without this it would keep executing a run the reaper had already reassigned.
   *
   * It points at a different problem from `lease-stolen`, which is why it is not
   * folded into it: a stolen lease means this host is slow or the lease is too
   * short, while this means this host cannot talk to the database.
   */
  | "lease-expired";

/**
 * The default sentence for each reason. A `Record` rather than a chain of
 * ternaries so that adding a `FenceReason` is a COMPILE error here — the
 * previous shape's `else` arm silently described every new reason as a deleted
 * workflow.
 */
const DEFAULT_MESSAGE: Record<FenceReason, string> = {
  "lease-stolen":
    "This worker's lease was reclaimed by another worker; abandoning the run.",
  "job-row-gone":
    "This job's row no longer exists (its workflow was probably deleted); abandoning the run.",
  "not-running":
    "This job is no longer running — the reaper took it back, or it was cancelled; abandoning the run.",
  "lease-expired":
    "This worker could not renew its lease for longer than the lease itself, so another worker is entitled to this job; abandoning the run.",
};

export class FencedError extends Error {
  readonly reason: FenceReason;

  constructor(reason: FenceReason, message?: string) {
    super(message ?? DEFAULT_MESSAGE[reason]);
    // Set here rather than as a class field so it survives regardless of
    // `useDefineForClassFields`, and so `err.name` identifies this across a
    // duplicated-module boundary where `instanceof` would not.
    this.name = "FencedError";
    this.reason = reason;
  }
}

/** True for a `FencedError` from any copy of this module. */
export function isFencedError(err: unknown): err is FencedError {
  return (
    err instanceof FencedError ||
    (err instanceof Error && err.name === "FencedError")
  );
}
