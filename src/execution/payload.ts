import type { FanOutChain } from "@/inngest/fan-out";

/**
 * What one workflow-execution request carries, apart from which workflow it is
 * for. The single declaration of that shape, owned by NEITHER runtime.
 *
 * Two things derive from it and must never disagree:
 *
 * - `SendWorkflowExecutionInput` (`src/inngest/utils.ts`) — this plus
 *   `workflowId` — the event `executeWorkflow` receives.
 * - `WorkflowJob.payload` — this exactly, since the job row holds `workflowId`
 *   in its own column. One JSON column on purpose: the enqueue seam's shape IS
 *   the queue's shape, so adding a field here reaches both runtimes at once.
 *
 * It lives outside `src/inngest/` because `src/inngest/` is being deleted. A
 * queue module importing this from `utils.ts` would also sit one careless
 * `import type` → `import` away from constructing the Inngest client inside the
 * worker and the Vercel bundle, since `utils.ts` imports `./client` for value.
 * Nothing here imports anything at runtime.
 *
 * ⚠️ `FanOutChain` is still imported from `src/inngest/fan-out.ts` — a type-only
 * edge, erased at compile time. That module is on the "reused verbatim, do not
 * fork" list and moves to `src/execution/` with the rest of the runtime-neutral
 * code in a later step; this import follows it then.
 *
 * The field comments below moved here verbatim from `SendWorkflowExecutionInput`
 * and still reason about Inngest's event-size ceiling. That reasoning is why the
 * mechanism EXISTS, and it is worth keeping intact: the queue inherits the
 * mechanism (a small reference on the wire, the bulk in Postgres) without
 * inheriting the ceiling that forced it.
 */
export type WorkflowExecutionPayload = {
  initialData?: Record<string, unknown>;
  // R2 key of a stored context snapshot to seed the run with, instead of an
  // inline `initialData`. Used when the snapshot exceeded the inline clamp —
  // an oversized payload must not ride the Inngest event (event size limits),
  // so `executeWorkflow` hydrates it from blob storage inside a step.
  initialDataBlobKey?: string;
  // Seed the run from a stored `NodeInputSnapshot` instead of an inline
  // `initialData`. Same reason as `initialDataBlobKey` above and NOT
  // interchangeable with passing the row's contents: a snapshot exists only
  // because the input passed the 32 KB clamp, and may be up to
  // `NODE_INPUT_SNAPSHOT_MAX_BYTES` (4 MB) — far past Inngest's event ceiling.
  // Only this small reference travels; `executeWorkflow` reads the row.
  initialDataSnapshot?: { executionId: string; nodeId: string };
  idempotencyKey?: string;
  // Replay-from-node: run only this node + its descendants, seeding the context
  // from `initialData` (the node's recorded input snapshot). `replayOfExecutionId`
  // links the new run back to the origin for lineage. Both omitted on normal runs.
  replayFromNodeId?: string;
  replayOfExecutionId?: string;
  // Fan-out chain link: this run is item `chain.index` of a fan-out, and is
  // responsible for dispatching the next one when it finishes. Carries its own
  // seed source, so `initialData` is derived from it rather than passed in.
  // See src/inngest/fan-out.ts for why children are chained instead of all
  // being dispatched up front.
  fanOutChain?: FanOutChain;
};
