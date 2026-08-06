import type { Realtime } from "@inngest/realtime";
import { NonRetriableError } from "inngest";
import { readNodeInputSnapshot } from "@/features/executions/lib/node-input-snapshot";
import type {
  ExecutorStep,
  WorkflowContext,
} from "@/features/executions/types";
import { ExecutionStatus, type Prisma } from "@/generated/prisma";
import { buildFanOutSeed, FAN_OUT_SEED_CLAMP_BYTES } from "@/inngest/fan-out";
import { readFanOutSource } from "@/inngest/fan-out-store";
import { type EngineStep, runWorkflowNodes } from "@/inngest/run-workflow";
import { getBlobJson } from "@/lib/blob";
import { clampJson } from "@/lib/clamp-json";
import prisma from "@/lib/db";
import { advanceFanOutChain, createFanOutDispatcher } from "./fan-out-dispatch";
import { createPrismaNodeRecorder } from "./node-recorder";
import { createPassthroughStep } from "./passthrough-step";
import type { WorkflowExecutionPayload } from "./payload";
import { topologicalSort } from "./topological-sort";

/**
 * ⚠️ **`src/execution/` is NOT Inngest-free yet, and this is the file that
 * proves it.** `./fan-out-dispatch` imports `sendWorkflowExecution` from
 * `@/inngest/utils` for VALUE, and that module imports `./client` for value —
 * so importing `runExecution` constructs the Inngest client and its realtime
 * middleware, in the worker process as much as in the Vercel app.
 *
 * Worth stating plainly here, because two sibling comments (`topological-sort.ts`
 * and `node-recorder.ts`) explain those files' new homes by saying they no
 * longer drag the client in — true of each of them alone, and misleading about
 * the folder as a whole.
 *
 * The edge closes in the step that makes dispatch runtime-aware; until then it
 * is one import, and it is cheap (constructing the client performs no I/O).
 * Nothing here should GROW a second such edge in the meantime.
 */

/**
 * Reads a JSON blob, turning any failure into a NonRetriableError that names
 * what could not be loaded. A missing or corrupt blob is a data problem no
 * retry resolves, so the caller seeding a run from a stored context snapshot
 * wants exactly this — and the wrapping lives here so the message stays one
 * sentence rather than a raw S3 error.
 *
 * Deliberately adjacent to its only caller rather than in a file of its own:
 * that caller is the LEGACY blob arm below, scheduled to be deleted once every
 * run predating the Postgres cutover has aged past the 30-day retention. Keeping
 * the two together makes that one cut instead of two.
 */
async function hydrateBlobJson<T>(key: string, what: string): Promise<T> {
  try {
    return (await getBlobJson(key)) as T;
  } catch (err) {
    throw new NonRetriableError(
      `Failed to load the ${what} (${key}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * A `runStep` that memoizes nothing — the one the self-hosted worker passes.
 *
 * Not a shortcut. `createWorkerStep({ executionId })` is keyed on an id that
 * `runExecution`'s items 1-4 are what produce, so there is nothing to memoize
 * them into. That costs nothing because of what they do, and each clause is
 * load-bearing:
 *
 *  - **check-idempotency, hydrate-initial-data, prepare-workflow** are pure
 *    reads. Re-running them on a resumed attempt costs three queries and yields
 *    the same answer.
 *  - **create-execution** is the only pre-engine write, and its `upsert` is what
 *    makes re-running it adopt the row it already made instead of failing.
 *  - **update-execution** is idempotent — the status write is a no-op on repeat
 *    and the chain advance is deduped by the next item's idempotency key.
 *
 * ⚠️ Anything added to `runExecution` outside `engineStepFor` inherits this. A
 * new non-idempotent write between items 1 and 6 would be re-executed by every
 * resumed attempt, silently, and no type would object.
 */
export const passthroughRunStep = createPassthroughStep(
  "step.ai.infer() is not available outside a node executor — this is " +
    "the run-level step, and nothing it wraps performs inference.",
);

export type RunExecutionResult =
  | { skipped: true; reason: "duplicate"; existingExecutionId: string }
  | { skipped: false; executionId: string; context: WorkflowContext };

/**
 * Everything between "a workflow execution was requested" and "the row says
 * SUCCESS" — with no knowledge of which runtime is calling.
 *
 * This is `executeWorkflow`'s body, lifted out so the Inngest function and the
 * self-hosted worker execute byte-identical runs. It does six things:
 *
 *  1. dedupe on `idempotencyKey`
 *  2. create the `Execution` row (+ derive a fan-out child's seed)
 *  3. resolve an out-of-band seed context
 *  4. load the graph and `topologicalSort` it
 *  5. run the engine
 *  6. mark SUCCESS and advance the fan-out chain
 *
 * Recording a FAILURE is deliberately not here: it is `settleFailedExecution`
 * (`./failure.ts`), because Inngest reaches it through a separate `onFailure`
 * callback that never sees this scope.
 *
 * ### Why there are two step parameters
 *
 * `runStep` wraps the run-level bookkeeping (items 1-4 and 6). `engineStepFor`
 * produces the step the ENGINE runs under. On Inngest they are the same object;
 * on the worker they cannot be, and the reason is structural rather than
 * stylistic:
 *
 * > `createWorkerStep({ executionId })` is scoped to an execution id, and items
 * > 1-4 are what PRODUCE that id. There is no step store to memoize them into
 * > until item 2 has run.
 *
 * That costs the worker nothing, because of what those items do. Items 1, 3 and
 * 4 are **pure reads** — re-running them on a resumed attempt costs three
 * queries and yields the same answer, so the worker passes a pass-through
 * `runStep` that simply invokes the callback. Item 2 is the only pre-engine
 * write, and its `upsert` is its own memo: keyed on `inngestEventId`, which is
 * stable across every attempt of one job, so re-running it adopts the row rather
 * than making a second. Item 6 is idempotent by construction (see its comment).
 *
 * A factory rather than a runtime flag this function branches on: a branch would
 * put "which runtime am I" inside the one piece of code whose entire purpose is
 * not knowing.
 */
export async function runExecution({
  workflowId,
  inngestEventId,
  payload,
  runStep,
  engineStepFor,
  publish,
  onExecutionCreated,
}: {
  workflowId: string;
  /**
   * The run's globally-unique external id. An Inngest event id on that runtime;
   * a synthetic `job_<jobId>` on the worker, which has no Inngest event and must
   * still satisfy `Execution.inngestEventId`'s NOT NULL unique constraint. The
   * column is renamed when Inngest is deleted, not before — two live code paths
   * address rows by it.
   */
  inngestEventId: string;
  payload: WorkflowExecutionPayload;
  /** Run-level bookkeeping: items 1-4 and 6. See the header. */
  runStep: ExecutorStep;
  /** The engine's step, scoped to the run this function creates. */
  engineStepFor: (executionId: string) => EngineStep;
  publish: Realtime.PublishFn;
  /**
   * Called the moment the `Execution` row exists — NOT when the run finishes.
   * The worker records the id on its job row here, which is what lets a failure
   * mid-run be attributed to a run at all. Leaving it to completion would leave
   * the id unset for exactly the attempts that need it.
   */
  onExecutionCreated?: (executionId: string) => Promise<void>;
}): Promise<RunExecutionResult> {
  const {
    initialData: inlineInitialData,
    initialDataBlobKey,
    initialDataSnapshot,
    idempotencyKey,
    replayFromNodeId,
    replayOfExecutionId,
    fanOutChain,
  } = payload;

  if (idempotencyKey) {
    const existing = await runStep.run("check-idempotency", async () => {
      return prisma.execution.findUnique({
        // Scoped to this workflow: the key names the external event, so an
        // identical key under a DIFFERENT workflow is a different run that
        // must not be deduped away (a copied workflow watching the same
        // sheet, or another tenant watching the same public video).
        where: { workflowId_idempotencyKey: { workflowId, idempotencyKey } },
        select: { id: true, status: true },
      });
    });

    if (existing) {
      // Deliberately NO fan-out advance here. A duplicate is a re-send of a
      // link the original run already owns, and that original advances the
      // chain itself (on success or through the failure path). Advancing from
      // here too would race a sibling that is still running, which is exactly
      // the out-of-order dispatch chaining exists to prevent.
      return {
        skipped: true,
        reason: "duplicate",
        existingExecutionId: existing.id,
      };
    }
  }

  // Creates the run's row and resolves the context it starts from. A fan-out
  // child DERIVES its seed from the chain descriptor plus the payload its
  // parent stored, rather than receiving it as `initialData` — which is what
  // lets a link on the wire be a cursor instead of a copy of the data.
  //
  // Folded into this one step on purpose: the derivation is needed here
  // anyway (the row persists the seed as `input`, which is what `rerun`
  // replays), so chaining costs no extra billed Inngest step per child.
  //
  // Returning the seed from a step DOES put it in Inngest's memoized run
  // state, which is re-shipped at every later step boundary. That is not a
  // regression to undo by moving the payload back onto the event: the event
  // is re-shipped per invocation too, and it used to carry the context plus
  // every REMAINING item, so state now holds strictly less (context + one
  // item) than the event previously did. Deriving it outside the step is no
  // longer possible in any case — the payload lives in Postgres, and reading
  // it outside a step would mean an uncheckpointed query per invocation.
  const { id: executionId, chainSeed } = await runStep.run(
    "create-execution",
    async (): Promise<{
      id: string;
      chainSeed?: Record<string, unknown>;
    }> => {
      // What the row starts with. Four sources, written as early returns rather
      // than one nested expression for the same reason `resolveInitialData`
      // below is: the legacy blob arm is scheduled to be deleted in one cut once
      // every run predating the Postgres cutover has aged out, and it should
      // lift out cleanly rather than have to be unpicked from the middle of a
      // ternary.
      //
      // A fan-out child gets `{}` here and its real seed from the second write
      // below, once the seed has been derived — the row has to exist first, so
      // that a failed read lands on a *visible* FAILED run. Everything else
      // persists the trigger payload (or, for a replay, the seeded snapshot) so
      // the run can be re-dispatched verbatim; blob-seeded runs store a small
      // reference instead of the oversized payload, and `rerun` resolves it back
      // to `initialDataBlobKey`.
      const seedInput = (): Prisma.InputJsonValue => {
        if (fanOutChain) return {};
        if (initialDataBlobKey) return { __blobRef: initialDataBlobKey };
        return (inlineInitialData ?? {}) as Prisma.InputJsonValue;
      };

      // `upsert`, not `create`, and this is the one place where being correct
      // for both runtimes beat being byte-identical to the Inngest path.
      //
      // The fan-out arm below has always upserted, because it makes a SECOND
      // failable write after the row exists and Inngest re-runs the whole
      // callback on retry — a plain `create` would then hit the
      // `inngestEventId` unique constraint and fail identically forever,
      // turning a transient DB blip into a permanently dead fan-out item.
      //
      // A runtime that re-enters this function from the top WITHOUT a memoized
      // step needs the same recovery for the ordinary arm. `inngestEventId` is
      // stable across every attempt of one job (`job_<jobId>`), so this re-finds
      // the row a crashed attempt already made; on a genuinely fresh run it is
      // indistinguishable from `create`. That makes it the SINGLE create-or-adopt
      // path — deliberately, rather than also reading the id back off the job
      // row, which would be a second mechanism for one invariant and the only
      // path that could write to a row this `where` never identified.
      //
      // ⚠️ Measured cost: `update: {}` does NOT compile to a native
      // `INSERT … ON CONFLICT`. Prisma emulates it as SELECT-then-INSERT, so
      // this is two round trips where `create` was one, on every run. Verified
      // against the real query log; `update: { <self-assignment> }` does not
      // restore the native form either. Accepted: one indexed lookup on a unique
      // column, against a run that issues dozens of statements, buys one code
      // path and closes a permanently-dead-run hole.
      const created = await prisma.execution.upsert({
        where: { inngestEventId },
        create: {
          workflowId,
          inngestEventId,
          idempotencyKey: idempotencyKey ?? null,
          input: seedInput(),
          // Link a replay back to its origin run; null for ordinary runs.
          replayOfId: replayOfExecutionId ?? null,
        },
        update: {},
        select: { id: true },
      });

      // Ordinary (non-chain) run: the row above is all of it.
      if (!fanOutChain) return { id: created.id };

      const seed = buildFanOutSeed({
        ...(await readFanOutSource(fanOutChain)),
        outputKey: fanOutChain.outputKey,
        index: fanOutChain.index,
        total: fanOutChain.total,
      });

      // Clamped rather than offloaded: a fan-out's item LIST being large says
      // nothing about one item's seed — 1000 small rows make a big list and
      // small seeds — so the clamp is the proportionate guard. Budgeted at
      // `FAN_OUT_SEED_CLAMP_BYTES` rather than `clampJson`'s 32 KB default
      // because `input` is what `rerun` replays from; see that constant.
      await prisma.execution.update({
        where: { id: created.id },
        data: {
          input: clampJson(
            seed,
            FAN_OUT_SEED_CLAMP_BYTES,
          ) as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      return { id: created.id, chainSeed: seed };
    },
  );

  await onExecutionCreated?.(executionId);

  // Hydrate a seed context that travelled as a REFERENCE rather than inline,
  // because it was too large for the event. Runs AFTER create-execution so a
  // missing/unreadable snapshot fails a *visible* run; before the row exists,
  // the Inngest failure path's update-by-eventId would itself throw and the
  // failure would be invisible. Step outputs already carry full contexts between
  // nodes, so pulling the snapshot inside a step adds no new size bound. A
  // missing one is a data problem a retry won't fix. A fan-out child's seed is
  // already resolved inside create-execution, so there is nothing left to fetch.
  //
  // Written as four early returns rather than one nested expression so each
  // source is independently readable — and independently DELETABLE: the
  // legacy blob arm is scheduled to go once every run predating the Postgres
  // cutover has aged out (see `NodeInputSnapshot`), and it should lift out in
  // one cut rather than have to be unpicked from the middle of a ternary.
  const resolveInitialData = async (): Promise<
    Record<string, unknown> | undefined
  > => {
    if (chainSeed) return chainSeed;

    if (initialDataSnapshot) {
      return runStep.run("hydrate-initial-data", async () => {
        const stored = await readNodeInputSnapshot(
          initialDataSnapshot.executionId,
          initialDataSnapshot.nodeId,
        );
        if (!stored) {
          throw new NonRetriableError(
            "The stored input snapshot for this replay " +
              `(node ${initialDataSnapshot.nodeId} of execution ` +
              `${initialDataSnapshot.executionId}) no longer exists. ` +
              "Re-run the whole workflow instead.",
          );
        }
        return stored as Record<string, unknown>;
      });
    }

    // LEGACY: runs recorded before snapshots moved to Postgres.
    if (initialDataBlobKey) {
      return runStep.run("hydrate-initial-data", () =>
        hydrateBlobJson<Record<string, unknown>>(
          initialDataBlobKey,
          "stored context snapshot",
        ),
      );
    }

    return inlineInitialData;
  };

  const initialData = await resolveInitialData();

  const { sortedNodes, connections, userId } = await runStep.run(
    "prepare-workflow",
    async () => {
      const workflow = await prisma.workflow.findUniqueOrThrow({
        where: { id: workflowId },
        include: {
          nodes: true,
          connections: true,
        },
      });

      return {
        sortedNodes: topologicalSort(workflow.nodes, workflow.connections),
        connections: workflow.connections.map((c) => ({
          fromNodeId: c.fromNodeId,
          toNodeId: c.toNodeId,
          fromOutput: c.fromOutput,
          toInput: c.toInput,
        })),
        userId: workflow.userId,
      };
    },
  );

  const engineStep = engineStepFor(executionId);

  // Run each node in topological order, threading context from one to the
  // next and following only active branches. The recorder writes a
  // NodeExecution row per node for observability.
  const context = await runWorkflowNodes({
    sortedNodes,
    connections,
    userId,
    executionId,
    initialData,
    step: engineStep,
    publish,
    recorder: createPrismaNodeRecorder({ executionId }),
    fanOutDispatcher: createFanOutDispatcher({
      step: engineStep,
      executionId,
      workflowId,
    }),
    replayFromNodeId,
  });

  await runStep.run("update-execution", async () => {
    await prisma.execution.update({
      where: { id: executionId, workflowId },
      data: {
        status: ExecutionStatus.SUCCESS,
        completedAt: new Date(),
        output: context as Prisma.InputJsonObject,
      },
    });

    // Hand the fan-out chain to its next item. Deliberately inside THIS step
    // rather than one of its own: Inngest bills per step, and a dedicated
    // advance step would add one per child for no behavioural gain. On the
    // worker a step is one INSERT, so that argument evaporates — but they stay
    // together anyway, because the two must not be able to diverge. A run
    // marked SUCCESS whose chain never advanced silently drops every remaining
    // item, and identical structure is what keeps the two runtimes comparable
    // row for row.
    //
    // Safe to repeat — the update above is idempotent and the send below is
    // deduped by the next item's idempotency key — which is what lets the
    // worker run this step un-memoized.
    //
    // The failed-item counterpart lives in `settleFailedExecution`; between
    // them, every terminal outcome of a child advances the chain (or
    // deliberately ends it), so it can never stall silently.
    if (fanOutChain) {
      await advanceFanOutChain({
        chain: fanOutChain,
        workflowId,
        failed: false,
      });
    }

    return { advanced: Boolean(fanOutChain) };
  });

  return { skipped: false, executionId, context };
}
