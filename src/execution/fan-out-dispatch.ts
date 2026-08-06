import { NonRetriableError } from "inngest";
import type { ExecutorStep } from "@/features/executions/types";
import {
  FAN_OUT_SOURCE_MAX_BYTES,
  type FanOutChain,
  fanOutItemIdempotencyKey,
  planChainAdvance,
  planFanOutChain,
  remainingAfter,
} from "@/inngest/fan-out";
import { storeFanOutSource } from "@/inngest/fan-out-store";
import type { FanOutDispatcher } from "@/inngest/run-workflow";
import { sendWorkflowExecution } from "@/inngest/utils";
import { DEFAULT_ON_ITEM_FAILURE } from "@/lib/multi-match";

/**
 * Postgres-backed FanOutDispatcher: starts a fan-out node's CHAIN of child
 * sub-executions — each child a replay-from-node run of the fan-out node +
 * descendants, seeded with one item.
 *
 * Two side effects, both inside one existing step: the shared payload is stored
 * ONCE (`FanOutSource` + one `FanOutItem` per item), and item 0 is sent. Each
 * child dispatches the next as it finishes (see `advanceFanOutChain`), which is
 * what makes children run in item order: Inngest gives no ordering guarantee
 * across separate runs, so the previous dispatch-all-at-once landed N events
 * effectively tied and they ran shuffled. Chaining costs no throughput —
 * `executeWorkflow`'s `concurrency: { limit: 1 }` already serialized them (and
 * the queue's partial unique index does the same for worker runs) — and no
 * extra billed steps, because the advance rides inside the child's existing
 * `update-execution` step.
 *
 * Storing the payload rather than putting it on the event is what keeps a link
 * a fixed-size cursor; see the header of src/inngest/fan-out.ts for why the
 * carry-the-remaining-items version was O(N^2) and needed R2 to survive.
 *
 * Both effects happen inside a `step.run` so a retry re-runs them: the write is
 * an upsert (+ `skipDuplicates`) and the child's own idempotency check dedupes
 * the re-sent event on the per-item `idempotencyKey`.
 *
 * ⚠️ `step` is an `ExecutorStep`, not the full `StepTools` this was written
 * against. Only `step.run` was ever used, and the worker's `WorkerStep` is an
 * `ExecutorStep` — so the wider type would have made this helper uncallable
 * from the worker, and the type error would only have surfaced in Step 5.
 */
export function createFanOutDispatcher({
  step,
  executionId,
  workflowId,
}: {
  step: ExecutorStep;
  executionId: string;
  workflowId: string;
}): FanOutDispatcher {
  return {
    async dispatch({ nodeId, outputKey, context, items, onItemFailure }) {
      await step.run(`fan-out:${nodeId}`, async () => {
        const planned = planFanOutChain({
          items,
          context,
          outputKey,
          executionId,
          nodeId,
          onItemFailure: onItemFailure ?? DEFAULT_ON_ITEM_FAILURE,
        });

        // No items — nothing to chain. The engine has already activated no
        // outgoing edge, so the downstream sub-graph is recorded SKIPPED.
        if (!planned) return { dispatched: 0 };

        // A guard, not a routing decision: there is one storage path now, so
        // this only stops an unstorable payload from being written at all.
        // Infinite bytes is `planFanOutChain`'s signal for "not serializable",
        // which needs its own sentence — "Infinity MB" tells nobody anything.
        if (planned.sourceBytes > FAN_OUT_SOURCE_MAX_BYTES) {
          throw new NonRetriableError(
            Number.isFinite(planned.sourceBytes)
              ? `This fan-out's ${items.length} items come to ` +
                  `${Math.round(planned.sourceBytes / 1_048_576)} MB, over the ` +
                  `${FAN_OUT_SOURCE_MAX_BYTES / 1_048_576} MB limit for one ` +
                  "step's item list. Narrow the filter, or select fewer fields " +
                  "per item."
              : `This fan-out's ${items.length} items could not be stored ` +
                  "because something reaching this step is not valid JSON — a " +
                  "circular reference or a BigInt, most likely.",
          );
        }

        // Written once for the whole chain, read one item at a time by each
        // child.
        await storeFanOutSource({
          executionId,
          nodeId,
          source: planned.source,
        });

        await sendWorkflowExecution({
          workflowId,
          replayFromNodeId: nodeId,
          replayOfExecutionId: executionId,
          idempotencyKey: fanOutItemIdempotencyKey(executionId, nodeId, 0),
          fanOutChain: planned.chain,
        });

        return { dispatched: 1, total: items.length };
      });
    },
  };
}

/**
 * The sentence appended to a failed run's error when a fan-out was cut short.
 *
 * Items that never start leave no rows of their own, so the run that dropped
 * them is the only place the truncation can be reported — without this, "why
 * did the last N items never run?" has no answer anywhere in the UI. Empty
 * when nothing was stranded, so callers can append unconditionally.
 */
export function strandedNote(count: number, because: string): string {
  if (count <= 0) return "";
  return (
    `\n\nThe remaining ${count} item${count === 1 ? "" : "s"} of this ` +
    `fan-out were not started, because ${because}.`
  );
}

/**
 * Hands a fan-out chain on to its next item. Called from BOTH the success path
 * (inside `update-execution`) and the failure path — a failed item must still
 * advance when the policy is "continue", or one bad item silently drops every
 * remaining one. A double advance is harmless: the next child's idempotency key
 * dedupes it.
 *
 * Returns the number of items that will never start, which is non-zero only
 * when a "stop" policy cut the chain short.
 */
export async function advanceFanOutChain({
  chain,
  workflowId,
  failed,
}: {
  chain: FanOutChain;
  workflowId: string;
  failed: boolean;
}): Promise<{ abandoned: number }> {
  if (failed && chain.onItemFailure === "stop") {
    return { abandoned: remainingAfter(chain) };
  }

  const next = planChainAdvance(chain);
  if (!next) return { abandoned: 0 };

  await sendWorkflowExecution({
    workflowId,
    replayFromNodeId: chain.nodeId,
    // Lineage points at the ORIGINAL parent run, not the sibling that happened
    // to dispatch this one — every child of a fan-out is a child of the run
    // that fanned out, however the chain physically reached it.
    replayOfExecutionId: chain.executionId,
    idempotencyKey: next.idempotencyKey,
    fanOutChain: next.chain,
  });

  return { abandoned: 0 };
}
