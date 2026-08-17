import { describe, expect, it } from "vitest";
import {
  CANCELLED_JOB_RETENTION_DAYS,
  EXECUTION_RETENTION_DAYS,
  FAILED_JOB_RETENTION_DAYS,
  SUCCEEDED_JOB_RETENTION_DAYS,
} from "./retention";

/**
 * These numbers are only correct in relation to each other, and the
 * relationship is the kind nobody re-derives when changing one of them — which
 * is exactly why it is asserted rather than left to the comment that explains
 * it.
 */
describe("retention windows", () => {
  it("expires a SUCCEEDED job strictly before the Execution it produced", () => {
    // The invariant. A job row deduplicates its `(workflowId, idempotencyKey)`
    // for as long as it survives, while `Execution`'s constraint on the same
    // pair is the real guarantee. Let the job outlive the execution and a key
    // re-sent in the gap is DROPPED by the worker but RUN by Inngest — the two
    // runtimes disagreeing about one external event, decided by nothing but
    // which one the workflow happens to be routed to.
    //
    // Shorter is always safe; longer is the bug. Hence a strict inequality
    // rather than a specific pair of numbers, so tuning either stays free.
    expect(SUCCEEDED_JOB_RETENTION_DAYS).toBeLessThan(EXECUTION_RETENTION_DAYS);
  });

  it("expires a CANCELLED job strictly before the Execution window too", () => {
    // Same reasoning, and worse: a cancelled job never ran, so there is no
    // `Execution` row beside it holding the key. While the row lives it is the
    // ONLY thing deduplicating that key, and nothing on the Inngest side
    // matches it at all.
    expect(CANCELLED_JOB_RETENTION_DAYS).toBeLessThan(EXECUTION_RETENTION_DAYS);
  });

  it("expires a FAILED job strictly before the Execution it mirrors", () => {
    // Not a restatement of the definition, and an earlier revision got this
    // wrong by setting the two EQUAL. The windows are measured from different
    // anchors — `Execution.startedAt` versus `WorkflowJob.updatedAt`, which is
    // later by the run's own duration plus every backoff before it gave up — so
    // equal numbers let the job outlive the execution, leaving the job row as
    // the sole holder of the idempotency key. Strictly-less is the property
    // that has to hold; the exact margin is free to change.
    expect(FAILED_JOB_RETENTION_DAYS).toBeLessThan(EXECUTION_RETENTION_DAYS);
  });

  it("keeps every window positive", () => {
    // A zero or negative window would delete rows the moment they settle,
    // taking the dedup optimisation and `lastError` with them.
    for (const days of [
      EXECUTION_RETENTION_DAYS,
      SUCCEEDED_JOB_RETENTION_DAYS,
      FAILED_JOB_RETENTION_DAYS,
      CANCELLED_JOB_RETENTION_DAYS,
    ]) {
      expect(days).toBeGreaterThan(0);
    }
  });
});
