import type { ExecutionRuntimeName } from "@/execution/runtime";
import type { WorkflowContext } from "@/features/executions/types";
import type { OnItemFailure } from "@/lib/multi-match";

/**
 * Fan-out planning, kept pure (no Inngest/Prisma/blob imports) so the seed
 * shape, idempotency keys, the stored-payload split and the chain advance are
 * all unit testable in isolation. `executeWorkflow`'s `FanOutDispatcher` calls
 * `planFanOutChain` and then does the actual side effects (the `FanOutSource`
 * write + `sendWorkflowExecution`) with the plan it returns.
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
 *
 * ## Why a link carries a CURSOR and nothing else
 *
 * Chaining is what made payload size the hard part. The first version had each
 * link carry the shared context plus the items still to do, so link i held
 * N - i items: an N-item fan-out moved O(N^2) bytes, and a few hundred sheet
 * rows blew past the Inngest event budget. The escape hatch was to park the
 * payload in R2 — which made an optional dependency load-bearing, so an
 * unconfigured bucket killed the run outright.
 *
 * Now the parent writes the shared context and the items ONCE, to `FanOutSource`
 * / `FanOutItem` in Postgres, and a link on the wire is just
 * `{ nodeId, outputKey, index, total, executionId, onItemFailure }` — a couple
 * of hundred bytes, the same for item 0 of 5 and item 900 of 1000. The chain is
 * O(N) in bytes and has no size ceiling to trip over. Postgres rather than R2
 * because blob storage is optional everywhere else in this codebase, and the
 * database is not.
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
 * Clamp applied to a child's seed when it is persisted as `Execution.input`.
 *
 * Deliberately NOT `clampJson`'s 32 KB default: `input` is what `rerun` replays
 * from, so a truncation marker there would re-dispatch the workflow with
 * `{__truncated}` as its context. 128 KB keeps realistic seeds intact while
 * still bounding a pathological one. Nothing about this value touches the
 * event — a link carries only a cursor now.
 */
export const FAN_OUT_SEED_CLAMP_BYTES = 131_072;

/**
 * Ceiling on the stored payload of one fan-out (shared context + every item).
 *
 * Not a routing decision — there is only one path now — purely a guard so an
 * absurd fan-out fails with a sentence the user can act on instead of writing
 * hundreds of megabytes into Postgres. `MAX_FAN_OUT_ITEMS_LIMIT` (1000) caps the
 * item COUNT and says nothing about item size; 32 MB across the list allows an
 * average of ~32 KB per item at that limit, far above the row- and record-shaped
 * payloads this actually carries.
 */
export const FAN_OUT_SOURCE_MAX_BYTES = 33_554_432;

/**
 * A chain link: which item of which fan-out this child run processes, and what
 * it needs to hand the chain on. Fixed size — the context and the items live in
 * `FanOutSource`/`FanOutItem`, keyed by `(executionId, nodeId)`, and `index`
 * selects this child's item from them.
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
  /** The parent run: half the `FanOutSource` key, and the lineage target. */
  executionId: string;
  /** Whether a failed item stops the chain or lets it continue. */
  onItemFailure: OnItemFailure;
  /**
   * The runtime that started this chain. Every link finishes where item 0
   * began, whatever `Workflow.executionRuntime` says by then.
   *
   * ⚠️ **This is a correctness pin, not a lineage note.** The two runtimes each
   * enforce "one run of this workflow at a time" — the partial unique index
   * `WorkflowJob_one_running_per_workflow` on one side, Inngest's
   * `concurrency: { key: event.data.workflowId, limit: 1 }` on the other — and
   * NEITHER can see the other's. That interlock is what makes a chain ordered:
   * item 5's run cannot start while item 4's is still running. Split a chain
   * across both runtimes and the interlock disappears, so two items run at once
   * and the ordering the chain exists to preserve is gone.
   *
   * Stamped by `sendWorkflowExecution` when item 0 is dispatched and inherited
   * by every later link through `planChainAdvance`'s spread, so the resolution
   * costs one lookup per CHAIN rather than one per link.
   *
   * Optional only for chains already in flight across the deploy that
   * introduced it. Those predate any routing, so absent correctly reads as
   * `"inngest"` — see `resolveExecutionRuntime`.
   */
  runtime?: ExecutionRuntimeName;
};

/** The shared payload a chain's children read, written once by the parent. */
export type FanOutSource = {
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
  return `${fanOutChildKeyPrefix(executionId, nodeId)}${index}`;
}

/**
 * The key prefix shared by every child of one fan-out — for finding them all.
 * Derived from the same template as the key itself so a query and a key can
 * never disagree about the format.
 */
export function fanOutChildKeyPrefix(
  executionId: string,
  nodeId: string,
): string {
  return `fanout:${executionId}:${nodeId}:`;
}

/**
 * The 0-based item index in a child's idempotency key, or `null` if it is not
 * a fan-out key.
 *
 * LOCATES `fanout:` rather than indexing by position: rows written during the
 * brief window when workflow scoping was a `wf:<workflowId>:` key PREFIX (it is
 * now the `@@unique([workflowId, idempotencyKey])` constraint) carry that
 * prefix ahead of `fanout:`, so `split(":")[3]` reads the wrong segment on
 * them. Kept beside the builder as the format's only parser — the lineage badge
 * in `executions.tsx` and `scripts/verify-fan-out.ts` both route through here.
 */
export function parseFanOutItemIndex(key: string | null): number | null {
  if (!key) return null;
  const marker = key.indexOf("fanout:");
  if (marker === -1) return null;
  const parts = key.slice(marker).split(":");
  const index = Number(parts[3]);
  return parts.length === 4 && Number.isInteger(index) ? index : null;
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
 * The context a fan-out actually needs to store: everything EXCEPT the fan-out
 * node's own summary output.
 *
 * `buildFanOutSeed` overwrites `outputKey` with the per-item seed on arrival,
 * so whatever sat there is discarded by every child without being read — the
 * node's own executor short-circuits on the SEED (`readFanOutSeed`), never on
 * the summary. Keeping it is therefore provably dead weight, and it is not
 * small: a 156-row Sheets `find_rows` summary is ~75 KB of `rows` and
 * `columnValues`, duplicating the item list it was fanning out over.
 */
function carriedContext(
  context: WorkflowContext,
  outputKey: string,
): WorkflowContext {
  if (!(outputKey in context)) return context;
  const { [outputKey]: _ownSummary, ...rest } = context;
  return rest;
}

/**
 * Plans a fan-out: the payload to store once, and the link for item 0.
 *
 * `sourceBytes` is what the stored payload serializes to, measured here (where
 * the shared context has already been stripped) and enforced by the caller
 * against `FAN_OUT_SOURCE_MAX_BYTES` — the throw is the caller's because it
 * wants a `NonRetriableError`, and this module stays free of Inngest imports.
 * It costs one pass over data the caller is about to write anyway.
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
}: {
  items: unknown[];
  context: WorkflowContext;
  outputKey: string;
  executionId: string;
  nodeId: string;
  onItemFailure: OnItemFailure;
}): { chain: FanOutChain; source: FanOutSource; sourceBytes: number } | null {
  if (items.length === 0) return null;

  const source: FanOutSource = {
    context: carriedContext(context, outputKey),
    items,
  };

  let sourceBytes: number;
  try {
    sourceBytes = Buffer.byteLength(JSON.stringify(source), "utf8");
  } catch {
    // Unserializable (cycles, BigInt, …). It cannot be stored as JSON either,
    // so it fails the same guard rather than needing its own return channel —
    // infinity exceeds any budget. The caller words the two cases differently,
    // since "over the size limit" would be a lie about this one.
    sourceBytes = Number.POSITIVE_INFINITY;
  }

  return {
    chain: {
      nodeId,
      outputKey,
      index: 0,
      total: items.length,
      executionId,
      onItemFailure,
    },
    source,
    sourceBytes,
  };
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
    chain: { ...chain, index: nextIndex },
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
