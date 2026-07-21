import type { WorkflowContext } from "@/features/executions/types";
import { DEFAULT_CLAMP_BYTES } from "@/lib/clamp-json";

/**
 * Fan-out planning, kept pure (no Inngest/Prisma/blob imports) so the seed
 * shape, idempotency keys, blob keys, and the oversize decision are all unit
 * testable in isolation. `executeWorkflow`'s `FanOutDispatcher` calls
 * `planFanOutDispatches` and then does the actual side effects (blob upload +
 * `sendWorkflowExecution`) with the plan it returns.
 */

/**
 * Marker planted on each per-item seed under the fan-out node's outputKey. In
 * Step 2 the fan-out node's executor reads this back off its own output to tell
 * "I'm a child sub-execution, run in per-item mode" apart from "I'm the parent
 * run, produce the item list". Exported (and tested) now so the seam is stable.
 */
export const FAN_OUT_MARKER = "__fanOut";

/**
 * Whether `value` is a per-item fan-out seed (a non-null object carrying
 * `__fanOut === true`). Step 2's executor uses this to detect per-item mode.
 */
export function isFanOutItem(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[FAN_OUT_MARKER] === true
  );
}

/**
 * The per-item payload written under the fan-out node's outputKey in a child's
 * seed context. `index` is 1-based (user-facing) and `total` is the item count.
 */
export type FanOutItemSeed = {
  item: unknown;
  index: number;
  total: number;
  __fanOut: true;
};

/**
 * One child dispatch, fully planned. `seeded` is the child's `initialData`;
 * `oversized` says it must go through blob storage rather than inline on the
 * event; `blobKey` is where the oversized payload is parked.
 */
export type FanOutDispatchPlan = {
  index: number;
  idempotencyKey: string;
  seeded: Record<string, unknown>;
  oversized: boolean;
  blobKey: string;
};

/**
 * Builds the dispatch plan for a fan-out node's items. For item `i` (0-based):
 *
 * - `seeded` is the parent context with the node's own summary output (under
 *   `outputKey`) *overwritten* by the per-item `FanOutItemSeed` — so the child
 *   sees `{ item, index, total, __fanOut }` where the parent saw its summary.
 * - `idempotencyKey` includes `nodeId` so two fan-out nodes in the same
 *   execution can't collide, and `i` so items within a node stay distinct.
 *   `sendWorkflowExecution` additionally prefixes it with the workflow scope,
 *   so the stored key is `wf:<workflowId>:fanout:…`. Format consumer:
 *   `fanOutItemNumber` in src/features/executions/components/executions.tsx
 *   parses this key for the lineage badge — change the shape there too.
 * - `blobKey` sits under the existing `replay-contexts/${executionId}/` prefix
 *   so `pruneOldExecutions`'s blob GC drops it with zero new wiring.
 * - `oversized` is true when the inline seed would exceed `inlineLimitBytes`;
 *   a serialization failure (e.g. a BigInt in the context) also counts as
 *   oversized so we never throw here and the dispatcher routes it to a blob.
 */
export function planFanOutDispatches({
  items,
  context,
  outputKey,
  executionId,
  nodeId,
  inlineLimitBytes = DEFAULT_CLAMP_BYTES,
}: {
  items: unknown[];
  context: WorkflowContext;
  outputKey: string;
  executionId: string;
  nodeId: string;
  inlineLimitBytes?: number;
}): FanOutDispatchPlan[] {
  const total = items.length;
  return items.map((item, i) => {
    const index = i + 1;
    const seed: FanOutItemSeed = { item, index, total, __fanOut: true };
    const seeded: Record<string, unknown> = { ...context, [outputKey]: seed };

    let oversized: boolean;
    try {
      oversized =
        Buffer.byteLength(JSON.stringify(seeded), "utf8") > inlineLimitBytes;
    } catch {
      // Unserializable (cycles, BigInt, …) — can't ride the event inline, so
      // treat as oversized and let the dispatcher route it through a blob.
      oversized = true;
    }

    return {
      index,
      idempotencyKey: `fanout:${executionId}:${nodeId}:${i}`,
      seeded,
      oversized,
      // Under replay-contexts/${executionId}/ on purpose: pruneOldExecutions
      // GCs that whole prefix, so this needs no new retention wiring.
      blobKey: `replay-contexts/${executionId}/fan-out/${nodeId}/${i}.json`,
    };
  });
}
