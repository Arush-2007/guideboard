import { createId } from "@paralleldrive/cuid2";
import type { WorkflowExecutionPayload } from "@/execution/payload";
import {
  type ExecutionRuntimeName,
  isWorkerEventId,
  runtimeNameFromColumn,
} from "@/execution/runtime";
import prisma from "@/lib/db";
import { logger } from "@/lib/logger";
import { enqueueWorkflowJob } from "@/queue/jobs";
import { inngest } from "./client";
import type { FanOutChain } from "./fan-out";

/**
 * The event payload, which is `WorkflowExecutionPayload` plus the workflow it
 * targets. The fields and their reasoning live in `src/execution/payload.ts`,
 * declared once so this input and `WorkflowJob.payload` (which holds
 * `workflowId` in its own column) cannot drift as the shape grows.
 */
type SendWorkflowExecutionInput = WorkflowExecutionPayload & {
  workflowId: string;
};

/**
 * Which runtime took the run, and — on the queue path only — whether it created
 * anything.
 *
 * A discriminated union rather than a flat `{ runtime, dispatched }`, because a
 * flat boolean would have to lie on one arm: the queue can report "an identical
 * `(workflowId, idempotencyKey)` was already waiting" from its `ON CONFLICT`,
 * whereas `inngest.send` always accepts and the duplicate is not discovered
 * until `check-idempotency` runs inside the function. There is no honest value
 * for `enqueued` on the Inngest arm, so the type does not offer one.
 *
 * Nothing reads this today — all 16 call sites are a bare `await` — so it exists
 * for tests, for log lines, and for the first caller that needs to know where a
 * run went.
 */
export type SendWorkflowExecutionResult =
  | { runtime: "inngest" }
  | { runtime: "worker"; enqueued: boolean };

/**
 * Prisma error codes worth one more attempt at the enqueue INSERT.
 *
 * ⚠️ **The bar is NOT "does this look transient". It is "does this error PROVE
 * the INSERT never executed".** Nothing else is safe to retry here, and the
 * difference is a duplicate run rather than a slow one.
 *
 * `enqueueWorkflowJob` mints a fresh job id on every call, and the dedup
 * constraint is `(workflowId, idempotencyKey)` where **NULLs are distinct in
 * Postgres**. So for the many keyless runs — manual `execute`, `rerun`,
 * `replayFromNode`, a generic webhook with no `Idempotency-Key` — a retry after
 * an INSERT that actually committed inserts a SECOND row, and nothing
 * downstream can tell they are the same request. Two jobs, two `Execution`
 * rows, the workflow runs twice: two spreadsheet appends, two emails. That is
 * the failure this whole subsystem exists to prevent, arriving through the
 * safety net meant to avoid a lost trigger.
 *
 * So `P1017` ("server has closed the connection") is deliberately **NOT** here.
 * It is the one code that is genuinely ambiguous — the connection can drop
 * after the statement committed but before the answer comes back — and treating
 * an ambiguous outcome as a definite one is how the duplicate happens. A
 * dropped connection therefore fails loudly, exactly like the queue being down,
 * and the caller's own retry story (a webhook provider redelivering, an Inngest
 * `step.run`, a user clicking again) applies with the idempotency key intact.
 *
 * The two that remain both mean "no connection was ever obtained", so the
 * statement provably did not run.
 *
 * Matched on `.code` rather than on the error CLASS, because Prisma is not
 * consistent about which it uses: these arrive as
 * `PrismaClientInitializationError` when the pool is establishing a connection
 * and as `PrismaClientKnownRequestError` when an established one drops
 * mid-query. Both carry `.code`; only one satisfies an `instanceof`.
 */
const RETRYABLE_ENQUEUE_CODES = new Set([
  /** Can't reach database server — no connection, so no statement. */
  "P1001",
  /** Timed out fetching a new connection from the pool — likewise. */
  "P2024",
]);

function isRetryableEnqueueError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_ENQUEUE_CODES.has(code);
}

/**
 * Enqueue, with exactly one retry for a transient database fault.
 *
 * ## Why this never falls back to Inngest
 *
 * The tempting failure policy — "if the queue is unreachable, send it to
 * Inngest instead" — is a **correctness bug**, not a safety net. Each runtime
 * enforces "one run of this workflow at a time" through a mechanism the other
 * cannot see: the partial unique index `WorkflowJob_one_running_per_workflow`
 * here, `concurrency: { key: event.data.workflowId, limit: 1 }` there. A run
 * that falls back therefore executes CONCURRENTLY with the worker's run of the
 * same workflow — two executions appending to one spreadsheet, two emails.
 *
 * And it would fire at the worst possible time. The likeliest trigger is P2024,
 * a pool timeout local to ONE serverless instance — Postgres healthy, the
 * worker running normally. So the fallback's typical case is not a partition
 * that stopped everything; it is a busy Vercel function manufacturing a second
 * concurrent run against a perfectly live one. Failing loudly is the honest
 * outcome, and every caller already has a retry story: webhook providers
 * redeliver on 5xx, pollers sit inside an Inngest `step.run`, and a tRPC caller
 * is a person who can click again.
 *
 * ## Why the retry lives here and not in `enqueueWorkflowJob`
 *
 * That function accepts the CALLER's transaction client, and a failed statement
 * aborts the surrounding Postgres transaction (`25P02` — parent plan §9.19):
 * every later statement in it fails regardless of what went wrong first. A
 * retry inside someone else's transaction can therefore never succeed. Here it
 * always runs on the singleton, outside any transaction, which is the only
 * place the retry is meaningful.
 *
 * ⚠️ This answers "what if the insert THROWS", not "what if it never returns".
 * `$queryRaw` carries no client-side statement timeout, and P2024 bounds
 * waiting for a *connection*, not a query already in flight — so a genuinely
 * hung INSERT still blocks the caller until the platform's own function
 * timeout. Recorded rather than fixed: a timeout wrapper is new surface, and
 * the platform bound does exist. See parent plan §9.55.
 *
 * ⚠️ **Retrying is only safe because of what is NOT in the allowlist above.**
 * A retry re-INSERTs under a new job id, so retrying an error that might have
 * committed would double-queue every keyless run. Read that comment before
 * adding a code here. See parent plan §9.62.
 */
async function enqueueWithOneRetry(
  workflowId: string,
  payload: WorkflowExecutionPayload,
) {
  try {
    return await enqueueWorkflowJob({ workflowId, payload });
  } catch (error) {
    if (!isRetryableEnqueueError(error)) throw error;

    // Immediate rather than delayed: this runs inside a webhook handler, and a
    // pool timeout has already spent its own wait before throwing. Once, not a
    // loop — a second failure is an outage, and hiding an outage behind a retry
    // budget is how a queue backs up silently.
    logger.warn("Retrying workflow enqueue after a transient database error", {
      workflowId,
      code: (error as { code?: string }).code,
    });
    return await enqueueWorkflowJob({ workflowId, payload });
  }
}

/**
 * Which runtime should take this run.
 *
 * Ordinary runs read `Workflow.executionRuntime`, one indexed lookup by primary
 * key. A fan-out chain link does NOT — see below.
 *
 * A missing workflow row resolves to Inngest. That is not a real routing
 * decision so much as preserving today's behaviour for a workflow deleted
 * between trigger and dispatch (parent plan §9.17): the event is sent, and the
 * function then fails to load the workflow exactly as it does now.
 */
async function resolveExecutionRuntime({
  workflowId,
  fanOutChain,
}: {
  workflowId: string;
  fanOutChain?: FanOutChain;
}): Promise<ExecutionRuntimeName> {
  if (fanOutChain) {
    // Links 1..N: already pinned by item 0, inherited through
    // `planChainAdvance`'s spread. Free, and the common case by a factor of
    // however many items the fan-out has.
    if (fanOutChain.runtime) return fanOutChain.runtime;

    // Item 0 — dispatched from INSIDE the parent run, while that run is still
    // RUNNING. Resolved from the parent EXECUTION rather than from the column,
    // and the difference is not academic: read the column here and an operator
    // flipping it between the parent's start and this dispatch sends item 0 to
    // the other runtime while its own parent is live. That is the concurrent
    // pair `FanOutChain.runtime` exists to prevent, arriving through the very
    // mechanism meant to prevent it.
    //
    // The worker stamps a synthetic id into `inngestEventId` precisely because
    // a worker run has no Inngest event, so that column is an authoritative
    // record of what actually ran — as opposed to what the routing column
    // currently says should. `isWorkerEventId` owns the format; see
    // `workerEventId`, which writes it.
    const parent = await prisma.execution.findUnique({
      where: { id: fanOutChain.executionId },
      select: { inngestEventId: true },
    });

    // No parent row is pathological — item 0 is dispatched from within that
    // run, so it exists — and reachable only if the execution was deleted
    // mid-dispatch. Falling through to the column is then the best available
    // guess at the operator's current intent.
    if (parent) {
      return isWorkerEventId(parent.inngestEventId) ? "worker" : "inngest";
    }
  }

  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    select: { executionRuntime: true },
  });

  return runtimeNameFromColumn(workflow?.executionRuntime);
}

/**
 * The single enqueue seam: every trigger, poller, schedule tick, rerun,
 * replay-from-node, fan-out dispatch and chain advance goes through here, and
 * this is where a run is routed to one runtime or the other.
 *
 * ⚠️ **Both branches read and write through the `@/lib/db` singleton, including
 * inside the worker process, and that is correct.** `controlPlaneDb`
 * (src/worker/db.ts) is reserved for the claim loop, heartbeat and reaper; a
 * chain advance is run work, and putting it on the tiny control-plane pool
 * would let a dispatch compete with the heartbeat that keeps the run's own
 * lease alive — the self-starvation that pool exists to make impossible.
 *
 * Callers pass a key naming the EXTERNAL EVENT only — `gmail:<messageId>`,
 * `youtube:<commentId>`, `google_sheets:<sheetId>:<row>:…` — never the
 * workflow. Two workflows watching the same inbox, sheet, chat or video
 * legitimately both handle the same event, and each should run.
 *
 * That is enforced by the `@@unique([workflowId, idempotencyKey])` constraint
 * on `Execution` (see the schema), which `executeWorkflow`'s `check-idempotency`
 * step reads through. Scoping lives in the constraint rather than in the key's
 * text so it is a fact the database holds, not a prefix convention every
 * producer has to apply and every reader has to strip.
 */
export const sendWorkflowExecution = async ({
  workflowId,
  initialData,
  initialDataBlobKey,
  initialDataSnapshot,
  idempotencyKey,
  replayFromNodeId,
  replayOfExecutionId,
  fanOutChain,
}: SendWorkflowExecutionInput): Promise<SendWorkflowExecutionResult> => {
  const runtime = await resolveExecutionRuntime({ workflowId, fanOutChain });

  // Stamp the resolution into the chain so links 1..N inherit it. Done for BOTH
  // runtimes, not just the worker: a chain that started on Inngest must also
  // stay there when the column moves to WORKER mid-chain, or the split is
  // simply the same bug in the other direction.
  const chain: FanOutChain | undefined = fanOutChain
    ? { ...fanOutChain, runtime }
    : undefined;

  const payload: WorkflowExecutionPayload = {
    initialData: initialData ?? {},
    initialDataBlobKey,
    initialDataSnapshot,
    idempotencyKey,
    replayFromNodeId,
    replayOfExecutionId,
    fanOutChain: chain,
  };

  if (runtime === "worker") {
    const result = await enqueueWithOneRetry(workflowId, payload);
    return { runtime, enqueued: result.enqueued };
  }

  await inngest.send({
    name: "workflows/execute.workflow",
    data: { workflowId, ...payload },
    id: createId(),
  });

  return { runtime: "inngest" };
};
