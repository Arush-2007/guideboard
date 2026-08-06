import { NonRetriableError } from "inngest";
import type { ExecutorStep } from "@/features/executions/types";

/**
 * The non-memoizing halves of `ExecutorStep`, in one place.
 *
 * Three call sites need some of this, and before this module they were three
 * hand-maintained copies: the engine's `inlineStep` (a batched segment's nodes),
 * `runExecution`'s `passthroughRunStep` (run-level bookkeeping), and
 * `createWorkerStep`'s `ai` block (which memoizes `wrap` but has nothing to
 * offer for the rest).
 *
 * ⚠️ **The duplication mattered because the type system does not check any of
 * it.** Each site ends in `as unknown as ExecutorStep` — the one honest cast in
 * this codebase, since no runtime function can produce `Jsonify<T>` — and that
 * cast switches off checking for the WHOLE object. So when `ExecutorStep` grows
 * a member, every copy that misses it compiles cleanly and fails at runtime with
 * `undefined is not a function`, on whichever executor happens to reach for it.
 * One definition means one place to update.
 */

/**
 * `infer` and `models`, for a step that cannot perform inference.
 *
 * `infer` throws rather than being omitted, because the cast above means an
 * executor calling it would otherwise compile and then hit a bare `TypeError`.
 * The message is the caller's, since what to do instead differs by site.
 *
 * `models` is an empty descriptor map and NOT the same guarantee:
 * `step.ai.models.anthropic({…})` on it throws exactly the `TypeError` `infer`
 * exists to prevent. That is acceptable only because nothing in this codebase
 * reads it — all five AI executors call `ai.wrap` and construct their own
 * clients. A Proxy manufacturing a legible error would be machinery for a call
 * site that does not exist; if one ever appears, this is the note that says so.
 */
export function unavailableAi(inferMessage: string) {
  return {
    infer: async () => {
      throw new NonRetriableError(inferMessage);
    },
    models: {},
  };
}

/**
 * An `ExecutorStep` that runs every callback immediately and persists nothing.
 *
 * Trailing input is forwarded, matching `flushingStep`, `createWorkerStep` and
 * real `step.run`, all of which persist it — dropping it would hand an executor
 * `undefined` for arguments it declared.
 *
 * Callers must document WHY persisting nothing is safe at their site; the two
 * reasons are different. See `inlineStep` (the enclosing segment is the
 * checkpoint) and `passthroughRunStep` (the work is pure reads plus one
 * idempotent write).
 */
export function createPassthroughStep(inferMessage: string): ExecutorStep {
  return {
    run: async (
      _id: string,
      fn: (...input: unknown[]) => unknown,
      ...input: unknown[]
    ) => fn(...input),
    ai: {
      wrap: async (
        _id: string,
        fn: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ) => fn(...args),
      ...unavailableAi(inferMessage),
    },
    // ⚠️ The one cast. `ExecutorStep`'s `run` returns `Promise<Jsonify<T>>`,
    // which no runtime function can honestly produce — the value really has
    // been through JSON on the checkpointing paths, but only the type system's
    // word for it is missing here. See the header for what this costs.
  } as unknown as ExecutorStep;
}
