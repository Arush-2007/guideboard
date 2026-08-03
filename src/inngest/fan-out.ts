import type { WorkflowContext } from "@/features/executions/types";
import type { OnItemFailure } from "@/lib/multi-match";

/**
 * Fan-out planning, kept pure (no Inngest/Prisma/blob imports) so the seed
 * shape, idempotency keys, blob keys, the oversize decision, and the chain
 * advance are all unit testable in isolation. `executeWorkflow`'s
 * `FanOutDispatcher` calls `planFanOutChain` and then does the actual side
 * effects (blob upload + `sendWorkflowExecution`) with the plan it returns.
 *
 * ## Why children are CHAINED rather than dispatched all at once
 *
 * Each fan-out item becomes its own top-level `workflows/execute.workflow` run,
 * and Inngest gives no ordering guarantee across separate runs. Sending all N
 * events inside one step landed them effectively tied, so the scheduler picked
 * among them arbitrarily and the children ran out of item order — rows 1..N of a
 * sheet processed shuffled. `executeWorkflow`'s `concurrency: { limit: 1 }` is
 * misleading here: it guarantees one-at-a-time, but a concurrency limit controls
 * PARALLELISM, not ORDER, so the result was "serialized, in arbitrary order".
 *
 * So the parent dispatches item 1 only, and each child dispatches item i+1 as it
 * finishes. Child i+1 is not created until child i is done, which makes ordering
 * structural rather than a matter of scheduler luck. Because the concurrency
 * limit already serialized the children, this costs no throughput whatsoever.
 */

/**
 * Marker planted on each per-item seed under the fan-out node's outputKey. The
 * fan-out node's executor reads this back off its own output to tell "I'm a
 * child sub-execution, run in per-item mode" apart from "I'm the parent run,
 * produce the item list".
 */
export const FAN_OUT_MARKER = "__fanOut";

/**
 * Whether `value` is a per-item fan-out seed (a non-null object carrying
 * `__fanOut === true`). Executors detect per-item mode through this.
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
 * Inline limit for ONE chain descriptor riding on an Inngest event. Deliberately
 * NOT `DEFAULT_CLAMP_BYTES` (32 KB), which bounds what gets written to Postgres
 * — borrowing a DB clamp for an event budget would push ordinary fan-outs onto
 * blob storage for no reason. Inngest's event ceiling is 512 KB; 128 KB leaves
 * generous headroom while keeping virtually every real fan-out inline.
 */
export const FAN_OUT_CHAIN_INLINE_LIMIT_BYTES = 131_072;

/**
 * Ceiling on what an inline chain may move IN AGGREGATE, across all its links.
 *
 * The per-event limit alone does not bound this, and that gap bites hard: an
 * inline chain re-ships the shared context on every one of its N hops, so a
 * 100 KB first link that comfortably passes the per-event check still moves
 * ~100 MB over a 1000-item chain — to carry an item list that would fit in a
 * single blob. The aggregate check is what actually decides "is inline still
 * the cheap option here?", so both must pass.
 *
 * 8 MB is well above any realistic fan-out (a 50-row chain with an 8 KB context
 * is ~0.5 MB) while cutting over to blob storage long before the quadratic term
 * dominates — and blob is one write plus N small reads, which is strictly
 * cheaper past this point.
 */
export const FAN_OUT_CHAIN_TOTAL_BUDGET_BYTES = 8_388_608;

/**
 * What one child run carries so it can (a) build its own seed and (b) dispatch
 * the next child. Two shapes, collapsed by `resolveChainSeed`:
 *
 * - INLINE (the common case): `remaining` holds items[index..], so each hop
 *   carries strictly less than the last and the LARGEST payload is the first
 *   one — which is why the oversize decision only has to be made once, by the
 *   parent, in `planFanOutChain`.
 * - BLOB (oversize): `chainBlobKey` points at a single stored
 *   `{ context, items }`, written once by the parent; `index` selects the item.
 *
 * Inline is the default rather than always-blob because blob costs one R2 write
 * plus one R2 read on the critical path of EVERY child run. Inline is the
 * faster path exactly where it applies; blob takes over exactly where bytes
 * start to matter.
 */
export type FanOutChain = {
  /** The fan-out node, replayed-from in every child run. */
  nodeId: string;
  /** Context key the per-item seed is planted under. */
  outputKey: string;
  /** 0-based cursor: which item THIS child processes. */
  index: number;
  /** Total item count, surfaced to the user as `total` on the seed. */
  total: number;
  /** The parent run, for per-item idempotency keys and lineage. */
  executionId: string;
  /** Whether a failed item stops the chain or lets it continue. */
  onItemFailure: OnItemFailure;
  /** Inline shape: the shared parent context. */
  context?: WorkflowContext;
  /** Inline shape: items[index..] — shrinks by one each hop. */
  remaining?: unknown[];
  /** Blob shape: key of a stored `{ context, items }`. */
  chainBlobKey?: string;
};

/** What a chain blob holds — written once by the parent, read by each child. */
export type FanOutChainBlob = {
  context: WorkflowContext;
  items: unknown[];
};

/**
 * The per-item idempotency key. Sole owner of this format.
 *
 * `nodeId` is included so two fan-out nodes in the same execution can't
 * collide, and `i` so items within a node stay distinct. Stored verbatim —
 * `sendWorkflowExecution` adds no prefix, since workflow scoping is held by the
 * `@@unique([workflowId, idempotencyKey])` constraint rather than by the key's
 * text.
 *
 * Format consumer: `fanOutItemNumber` in
 * src/features/executions/components/executions.tsx parses this key for the
 * lineage badge — change the shape there too.
 */
export function fanOutItemIdempotencyKey(
  executionId: string,
  nodeId: string,
  index: number,
): string {
  return `fanout:${executionId}:${nodeId}:${index}`;
}

/**
 * Blob key for a chain's stored `{ context, items }`. Sits under the existing
 * `replay-contexts/${executionId}/` prefix on purpose: `pruneOldExecutions`'s
 * blob GC drops that whole prefix, so this needs zero new retention wiring.
 */
export function fanOutChainBlobKey(
  executionId: string,
  nodeId: string,
): string {
  return `replay-contexts/${executionId}/fan-out/${nodeId}/chain.json`;
}

/**
 * The seeded context a child run starts from: the parent context with the
 * fan-out node's own summary output (under `outputKey`) *overwritten* by the
 * per-item seed — so the child sees `{ item, index, total, __fanOut }` where
 * the parent saw its summary.
 */
export function buildFanOutSeed({
  context,
  outputKey,
  item,
  index,
  total,
}: {
  context: WorkflowContext;
  outputKey: string;
  /** 0-based cursor; surfaced to the user as 1-based on the seed. */
  index: number;
  item: unknown;
  total: number;
}): Record<string, unknown> {
  const seed: FanOutItemSeed = {
    item,
    index: index + 1,
    total,
    __fanOut: true,
  };
  return { ...context, [outputKey]: seed };
}

/**
 * Plans the FIRST link of a chain: the descriptor for item 0, plus whether the
 * whole chain has to be parked in a blob instead of riding inline.
 *
 * The oversize check runs on the inline descriptor for item 0, which is the
 * biggest one the chain will ever produce (`remaining` only shrinks), so one
 * measurement settles BOTH budgets for every hop: the per-event limit, and the
 * aggregate the chain will move across all N links. A serialization failure
 * (e.g. a BigInt in the context) also counts as oversized so we never throw
 * here and the dispatcher routes it to a blob.
 *
 * Returns `null` for an empty item list — there is no chain to start.
 */
export function planFanOutChain({
  items,
  context,
  outputKey,
  executionId,
  nodeId,
  onItemFailure,
  inlineLimitBytes = FAN_OUT_CHAIN_INLINE_LIMIT_BYTES,
  totalBudgetBytes = FAN_OUT_CHAIN_TOTAL_BUDGET_BYTES,
}: {
  items: unknown[];
  context: WorkflowContext;
  outputKey: string;
  executionId: string;
  nodeId: string;
  onItemFailure: OnItemFailure;
  inlineLimitBytes?: number;
  totalBudgetBytes?: number;
}): {
  chain: FanOutChain;
  oversized: boolean;
  blobKey: string;
  blob: FanOutChainBlob;
} | null {
  if (items.length === 0) return null;

  const head = {
    nodeId,
    outputKey,
    index: 0,
    total: items.length,
    executionId,
    onItemFailure,
  };
  const inline: FanOutChain = { ...head, context, remaining: items };

  let oversized: boolean;
  try {
    const firstLink = Buffer.byteLength(JSON.stringify(inline), "utf8");
    // BOTH budgets. The first link is the largest (`remaining` only shrinks),
    // so one measurement settles the per-event check for every hop — but the
    // chain re-ships that payload N times, and only the aggregate check
    // catches a link that is individually fine yet ruinous in bulk.
    // `firstLink * total` overestimates (later links are smaller) by roughly
    // 2x, which is the right direction for a safety ceiling.
    oversized =
      firstLink > inlineLimitBytes ||
      firstLink * items.length > totalBudgetBytes;
  } catch {
    // Unserializable (cycles, BigInt, …) — can't ride the event inline, so
    // treat as oversized and let the dispatcher route it through a blob.
    oversized = true;
  }

  const blobKey = fanOutChainBlobKey(executionId, nodeId);

  return {
    chain: oversized ? { ...head, chainBlobKey: blobKey } : inline,
    oversized,
    blobKey,
    blob: { context, items },
  };
}

/**
 * Collapses either chain shape down to the one `(context, item)` pair this
 * child needs. `blob` is the hydrated `chainBlobKey` payload and is required
 * for — and only for — the blob shape.
 */
export function resolveChainSeed(
  chain: FanOutChain,
  blob?: FanOutChainBlob | null,
): { context: WorkflowContext; item: unknown } {
  if (chain.chainBlobKey) {
    if (!blob) {
      throw new Error(
        `Fan-out chain references blob ${chain.chainBlobKey} but no payload was hydrated`,
      );
    }
    return { context: blob.context, item: blob.items[chain.index] };
  }
  // Inline: `remaining` is items[index..], so this child's item is its head.
  return { context: chain.context ?? {}, item: (chain.remaining ?? [])[0] };
}

/**
 * The next link, or `null` when this child was the last item.
 *
 * The single advance decision, called from BOTH the success path and
 * `onFailure` — a failed item must still hand the chain on when the policy is
 * "continue", or one bad row silently drops every remaining row. The returned
 * idempotency key makes a double advance (success path racing `onFailure`)
 * harmless: the duplicate child is deduped away.
 */
export function planChainAdvance(
  chain: FanOutChain,
): { chain: FanOutChain; idempotencyKey: string } | null {
  // One definition of "chain is finished", shared with `remainingAfter`, so the
  // two can't drift into disagreeing about the last item.
  if (remainingAfter(chain) === 0) return null;
  const nextIndex = chain.index + 1;

  return {
    chain: {
      ...chain,
      index: nextIndex,
      // Inline only: drop the item this run consumed, so each hop carries
      // strictly less than the last. Undefined on the blob shape, where the
      // cursor alone selects the item.
      ...(chain.remaining ? { remaining: chain.remaining.slice(1) } : {}),
    },
    idempotencyKey: fanOutItemIdempotencyKey(
      chain.executionId,
      chain.nodeId,
      nextIndex,
    ),
  };
}

/** How many items after this one never started when a chain stops early. */
export function remainingAfter(chain: FanOutChain): number {
  return Math.max(0, chain.total - chain.index - 1);
}
