import type { Realtime } from "@inngest/realtime";
import { getAsyncCtx } from "inngest/experimental";
import { logger } from "@/lib/logger";

/**
 * Stops a node-status `publish()` from becoming its own durable Inngest step.
 *
 * `@inngest/realtime`'s middleware wraps every publish in
 * `step.run("publish:<channel>")` UNLESS it can see it is already inside a step
 * (`middleware.js`: `store.executingStep || store.execution?.executingStep`).
 * Our executors publish "loading" before their work and "success"/"error" after
 * — both from the function handler body, where that flag is unset. So each one
 * became a checkpointed step.
 *
 * That is pure waste. On Inngest Cloud a step costs seconds of dispatch latency
 * regardless of the work in it, and this "work" is a fire-and-forget UI ping. A
 * dropped status update leaves a node briefly un-highlighted on the canvas;
 * paying for durability to prevent that is the wrong trade by a wide margin.
 *
 * Measured on a two-node probe (MANUAL_TRIGGER → HTTP_REQUEST) before this fix:
 *
 * ```
 * create-execution / prepare-workflow / nodes:0-0
 * publish:node-status:<userId>      <-- a step
 * http-request
 * publish:node-status:<userId>      <-- a step
 * update-execution
 * ```
 *
 * Two of the checkpointed node's three steps were status pings. Extrapolated to
 * a 60-node workflow that is ~100 steps of nothing.
 *
 * The fix sets the same flag the middleware reads, for the duration of the call
 * only. `AsyncContext` is explicitly a cross-library contract — its own type
 * declaration says the structure "can be used by other libraries, so cannot have
 * breaking changes" — and `executingStep` has exactly one other reader in the
 * SDK (`step.fetch()`'s fallback check, which we do not use).
 *
 * **The failure mode is deliberately benign.** If a future SDK renames or stops
 * honouring the flag, publishes go back to being steps: slower, never broken,
 * never silently dropped. That is why this is preferred over POSTing to
 * `/v1/realtime/publish` directly, where the same drift would silently stop
 * delivering status.
 *
 * Nodes running INSIDE a batched segment already publish for free — the segment's
 * own `step.run` sets the flag — so for them this is a no-op passthrough.
 */

/**
 * Marks "a publish is in flight". Only ever observed by the realtime
 * middleware's in-step check; the id is arbitrary and never becomes a step id.
 */
const PUBLISH_MARKER = { id: "node-status-publish" } as const;

export function directPublish(publish: Realtime.PublishFn): Realtime.PublishFn {
  return (async (message) => {
    // `getAsyncCtx` throws in some non-function contexts; treat any failure as
    // "not in a function", which is also the case in unit tests that drive the
    // engine with a shimmed publish.
    const ctx = await getAsyncCtx().catch(() => undefined);
    const execution = ctx?.execution;

    // No function context, or already inside a step (an inline node inside its
    // segment): the middleware will take the direct path unaided.
    const alreadyDirect = !execution || execution.executingStep;
    if (!alreadyDirect) execution.executingStep = PUBLISH_MARKER;

    try {
      return await publish(message);
    } catch (error) {
      // A status ping must never decide a workflow's outcome. Losing the step
      // wrapper also lost its retry, so without this a blip on the realtime API
      // would throw into the executor and fail the node — and even WITH the old
      // wrapper, an exhausted retry would have failed the whole run over a
      // canvas highlight. Swallowing is correct in both worlds: the node keeps
      // running and the UI just misses one frame.
      logger.error("Failed to publish node status", error);
      return undefined as never;
    } finally {
      // Restore rather than assume: only clear what this call set. Leaving it
      // set would make the SDK believe the whole handler body is one long step.
      if (!alreadyDirect && execution) delete execution.executingStep;
    }
  }) as Realtime.PublishFn;
}
