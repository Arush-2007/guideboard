import { unavailableAi } from "@/execution/passthrough-step";
import type { ExecutorStep } from "@/features/executions/types";
import {
  insertStepResultOrReadExisting,
  loadStepResults,
  type StepResultMap,
  toStoredJson,
} from "@/queue/step-store";
import { FencedError, isFencedError } from "./fenced-error";

/**
 * The step API the self-hosted worker hands to the engine — the replacement for
 * Inngest's `step.run` / `step.ai.wrap`.
 *
 * `createWorkerStep` returns a RUN-scoped root, and the root mints per-node
 * children. Both satisfy `ExecutorStep`, because the engine calls `step.run` in
 * two structurally different places:
 *
 * - **The root**, for its own batched-segment checkpoints
 *   (`step.run(\`nodes:${start}-${end}\`, …)` in `run-workflow.ts`). There is no
 *   node id at that call site, and none is needed: those ids are derived from topological
 *   POSITION and are already unique within a run, so they are stored verbatim —
 *   exactly the ids Inngest stores today.
 * - **`forNode(nodeId)`**, for the step handed to an executor. Ids here are
 *   prefixed `<nodeId>:`, which is what stops two nodes of the same type from
 *   colliding on a shared literal like `"get-credential"`. The reasoning, and
 *   why this is deliberately not Inngest's per-run auto-indexing, is in the
 *   header of `step-store.ts`.
 *
 * Executors are untouched by any of this. `"get-credential"` stays
 * `"get-credential"` in their source; only its on-disk key differs.
 */

export interface WorkerStepOptions {
  /** The `Execution` row this run's steps are memoized against. */
  executionId: string;
  /**
   * Aborted when the worker loses its lease, with a `FencedError` as the abort
   * reason. Supplied by `runJob`; optional only so a test can build a step
   * without one.
   */
  signal?: AbortSignal;
}

export type WorkerStep = ExecutorStep & {
  /** The step API for one node, namespacing its ids under `<nodeId>:`. */
  forNode(nodeId: string): ExecutorStep;
};

export function createWorkerStep({
  executionId,
  signal,
}: WorkerStepOptions): WorkerStep {
  /**
   * One lazily-loaded query for the whole run, shared by the root and every
   * node's step. The promise (not the map) is memoized so concurrent first
   * calls cannot issue two queries.
   *
   * Run-scoped by construction, never module scope. A cache at module scope
   * would leak stored values BETWEEN executions — the same wrong-value bug the
   * per-node key exists to prevent, with a far longer blast radius.
   *
   * ⚠️ A REJECTION is explicitly not cached, and that is not the same statement
   * as the memo being safe. A memoized failure is not a memoized value: one
   * connection blip on the first load would otherwise pin that rejected promise
   * for the rest of the run, so every later step replays a stale error from a
   * query it never issued — attributing the fault to steps that never touched
   * the database. Clearing it means the next step retries the load, which is the
   * only outcome that can still be correct.
   */
  let pending: Promise<StepResultMap> | null = null;
  const stepResults = (): Promise<StepResultMap> => {
    pending ??= loadStepResults(executionId).catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  };

  /**
   * The fence seam, and it is live: `runJob`'s heartbeat aborts this signal
   * with a `FencedError` the moment it learns — or concludes — that the lease
   * is gone.
   *
   * Checked at the top of EVERY `run`/`ai.wrap`, not only before a callback
   * that will actually execute. The plan asks for "before every step callback";
   * this is a strict superset and strictly safer, because it also stops a
   * fenced worker from fast-forwarding through a resumed run's memoized steps
   * and burning connections on a run it no longer owns.
   */
  const assertNotFenced = () => {
    if (!signal?.aborted) return;
    // Whoever aborts is expected to pass a `FencedError` as the abort reason,
    // so the log line keeps its lease-stolen / job-row-gone distinction.
    if (isFencedError(signal.reason)) throw signal.reason;
    throw new FencedError(
      "lease-stolen",
      "This worker's step signal was aborted without a FencedError reason, so " +
        "the cause is unknown; assuming the lease is gone and abandoning the run.",
    );
  };

  /**
   * Builds an `ExecutorStep` whose ids are namespaced under `prefix` (a node id,
   * or `""` for the engine's own steps).
   */
  function scope(prefix: string): ExecutorStep {
    /**
     * Per-call-site repeat counter, so one node calling the same id twice does
     * not memoize the second call onto the first.
     *
     * INSURANCE, not a fix: the only same-id-twice site in the codebase is
     * `convert/executor.ts:129` and `:144`, and those sit in mutually exclusive
     * `switch` branches, so at most one runs per node execution. It replays
     * deterministically because a replay re-runs the same code in the same
     * order.
     *
     * Local to this scope, never to the module — the counter must reset per
     * node, and a scope is per node (see `forNode`, which is idempotent so that
     * "per node" cannot degrade into "per call").
     */
    const calls = new Map<string, number>();

    /**
     * `<prefix>:<id>` on the first call, then `#1`, `#2`, … on repeats.
     *
     * The shape matches Inngest's (a suffix plus an index by call order, first
     * repeat = 1 — verified in `execution/v1.js:913-921`), which is the one part
     * worth staying familiar. The separator differs on purpose: Inngest's
     * `STEP_INDEXING_SUFFIX` is `":"`, which is already doing the node/step job
     * here, so a repeat would be indistinguishable from a namespace.
     */
    const qualify = (id: string): string => {
      const seen = calls.get(id) ?? 0;
      calls.set(id, seen + 1);
      const base = prefix ? `${prefix}:${id}` : id;
      return seen === 0 ? base : `${base}#${seen}`;
    };

    /** The whole durable-step contract: at most one execution per step id. */
    const memoized = async (
      id: string,
      fn: (...args: unknown[]) => unknown,
      args: unknown[],
    ): Promise<unknown> => {
      assertNotFenced();

      // Before the memo check, so a step's id depends only on call ORDER within
      // its node — identical on a fresh run and on a resume that skips the
      // callback. Deriving it after would renumber every repeat on replay.
      const stepId = qualify(id);

      const results = await stepResults();
      // `.has`, not a truthy `.get`: a stored `null` is a real memoized value
      // (a callback that returned nothing), and must not re-execute.
      if (results.has(stepId)) return results.get(stepId);

      const value = await fn(...args);

      const stored = await insertStepResultOrReadExisting({
        executionId,
        stepId,
        json: toStoredJson(stepId, value),
      });

      results.set(stepId, stored);
      // The STORED value, not `value` — see `insertStepResultOrReadExisting`.
      // It has been through `jsonb`, which is what makes a first run and a
      // resumed run return identical values rather than `Date` vs string.
      return stored;
    };

    return {
      // Trailing input is forwarded, matching `flushingStep`, `inlineStep` and
      // real `step.run`, all of which persist it. Dropping it would hand an
      // executor `undefined` for arguments it declared. Nothing here has to
      // substitute memoized input the way Inngest does on replay, because a
      // completed callback is never re-invoked at all.
      run: (
        id: string,
        fn: (...input: unknown[]) => unknown,
        ...input: unknown[]
      ) => memoized(id, fn, input),
      ai: {
        // Same machinery and the same namespacing as `run`: `wrap` is `run` with
        // the arguments passed through. The five LLM executors that use it read
        // only `steps[0].content[0]`, which is plain JSON, so the round trip
        // changes nothing they touch.
        wrap: (
          id: string,
          fn: (...args: unknown[]) => unknown,
          ...args: unknown[]
        ) => memoized(id, fn, args),
        // `infer` and `models` are shared with the engine's `inlineStep` and
        // `runExecution`'s run-level step — see `passthrough-step.ts` for why
        // one definition matters when the cast below checks nothing. Only
        // `wrap` differs here, because only `wrap` memoizes.
        ...unavailableAi(
          "step.ai.infer() is not available on the self-hosted worker — it is " +
            "executed by the Inngest platform, not by this process. Call the " +
            "provider directly inside step.ai.wrap() instead.",
        ),
      },
      // ⚠️ The one cast, and the same one `inlineStep` documents.
      // `ExecutorStep`'s `run` returns `Promise<Jsonify<T>>`, which no runtime
      // function can honestly produce — the value really has been through JSON,
      // but only the type system's word for it is missing.
    } as unknown as ExecutorStep;
  }

  // The root's own ids are already unique per run, so they are stored unprefixed.
  const root = scope("");

  /**
   * One scope per node id, memoized — `forNode` is idempotent.
   *
   * Not a micro-optimization. The repeat counter must reset per NODE, and
   * minting a fresh scope on every call would quietly weaken that to per CALL:
   * a caller that took two handles for one node would restart the counter, so a
   * node's second `run("convert", …)` would resolve to the FIRST call's step id
   * and be served its stored value instead of executing. Memoizing makes the
   * guarantee a property of this factory rather than a rule every future caller
   * has to remember.
   *
   * Safe to hold for the run's lifetime because a node executes at most once per
   * execution — the same constraint `StepResult`'s primary key encodes.
   */
  const nodeScopes = new Map<string, ExecutorStep>();

  return {
    ...root,
    forNode: (nodeId: string) => {
      const existing = nodeScopes.get(nodeId);
      if (existing) return existing;
      const created = scope(nodeId);
      nodeScopes.set(nodeId, created);
      return created;
    },
  } as WorkerStep;
}
