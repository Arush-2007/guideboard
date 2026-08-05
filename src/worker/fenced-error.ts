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
 * Why the fence fired. Both end the run identically — the distinction exists so
 * the log line is honest about which happened, because they point at different
 * problems: a stolen lease means the worker host is unhealthy (or the lease is
 * too short), while a vanished job row means the workflow was deleted mid-run.
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
  | "job-row-gone";

export class FencedError extends Error {
  readonly reason: FenceReason;

  constructor(reason: FenceReason, message?: string) {
    super(
      message ??
        (reason === "lease-stolen"
          ? "This worker's lease was reclaimed by another worker; abandoning the run."
          : "This job's row no longer exists (its workflow was probably deleted); abandoning the run."),
    );
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
