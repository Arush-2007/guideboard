import {
  buildFailureEmail,
  resolveFailureCause,
} from "@/features/executions/lib/failure-email";
import { ExecutionStatus, NodeExecutionStatus } from "@/generated/prisma";
import { type FanOutChain, remainingAfter } from "@/inngest/fan-out";
import prisma from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { logger } from "@/lib/logger";
import { advanceFanOutChain, strandedNote } from "./fan-out-dispatch";

/**
 * Which `Execution` row a failure belongs to.
 *
 * A union rather than a plain `executionId`, because the two runtimes learn the
 * answer at different times. The worker holds the id on its job row from the
 * moment the row exists (`attachExecutionToJob`), so it can always name it.
 * Inngest's `onFailure` is a SEPARATE callback that receives only the event —
 * it never sees the handler's scope, so `inngestEventId` is all it has.
 *
 * Both are unique columns on `Execution`, so this goes straight into Prisma's
 * `where` and no lookup is needed. Resolving one to the other instead would
 * have to happen AFTER the chain advance to preserve today's ordering (a run
 * whose row is missing must still hand the chain on before it throws), which
 * would leave half of this function's sequence in its caller.
 */
export type ExecutionLocator = { id: string } | { inngestEventId: string };

/**
 * Reads a message off a thrown value.
 *
 * ⚠️ Not `err instanceof Error`, and the difference is load-bearing on the
 * Inngest path: `onFailure` receives an error that has been through JSON, so it
 * is a plain `{ name, message, stack }` object and fails that check. `String()`
 * on it yields "[object Object]", which is what the user would have read in
 * their failure email. Duck-typing the property is what serves both a real
 * `Error` (the worker) and the deserialized shape (Inngest).
 */
const messageOf = (err: unknown): string => {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(err);
};

const stackOf = (err: unknown): string | undefined => {
  const stack = (err as { stack?: unknown } | null)?.stack;
  return typeof stack === "string" ? stack : undefined;
};

/**
 * Records a failed run: the whole of Inngest's `onFailure`, minus Inngest.
 *
 * The order is load-bearing, and it is the order `onFailure` used:
 *
 *  1. Advance the fan-out chain, if this run holds one. Best-effort, and FIRST
 *     so a "stop" policy can name the abandoned items in the same write.
 *  2. Resolve the cause and mark the row FAILED.
 *  3. Log once — the single Sentry capture point for run failures.
 *  4. Email the owner, best-effort.
 *
 * ⚠️ Callers must catch `FencedError` BEFORE reaching this function, never
 * inside it. A fenced worker no longer owns its job; routing it into "mark
 * FAILED" would mark failed a run another worker is at that moment finishing
 * successfully. Nothing here classifies errors, so that decision stays wholly
 * with the caller.
 *
 * Throws if the `Execution` row does not exist — deliberately, and unchanged
 * from the `update` it replaces. On the Inngest path a failure before the row
 * exists has nowhere to be recorded and never had. On the worker it does not
 * arise: `runExecution` reports the row the moment it is written, so an earlier
 * failure lands on the job row's `lastError` instead of vanishing.
 */
export async function settleFailedExecution({
  locate,
  error: thrown,
  workflowId,
  fanOutChain,
}: {
  locate: ExecutionLocator;
  /**
   * The thrown value. A real `Error` from the worker, or Inngest's
   * JSON-round-tripped `{ name, message, stack }` — see `messageOf`.
   */
  error: unknown;
  workflowId?: string;
  fanOutChain?: FanOutChain;
}): Promise<{ executionId: string; error: string }> {
  // Did ANY node get as far as recording? Zero rows means the run never
  // reached the engine's own failure path — see `resolveFailureCause`.
  const recordedNodes = await prisma.nodeExecution.count({
    where: { execution: locate },
  });
  let error = resolveFailureCause(recordedNodes, messageOf(thrown));

  // The failed half of the fan-out chain. This is load-bearing: a child
  // that fails is still the only thing holding the chain, so under the
  // default "continue" policy it MUST hand on, or one bad item silently
  // drops every item after it.
  //
  // Best-effort, like the email below — a send failure must never stop the
  // run from being recorded FAILED.
  if (fanOutChain && workflowId) {
    try {
      const { abandoned } = await advanceFanOutChain({
        chain: fanOutChain,
        workflowId,
        failed: true,
      });
      error += strandedNote(
        abandoned,
        "this step is set to stop the run when an item fails",
      );
    } catch (err) {
      logger.error("Failed to advance fan-out chain after a failure", err, {
        ...locate,
        nodeId: fanOutChain.nodeId,
        index: fanOutChain.index,
      });
      // The chain dies here — nothing else holds it. Same note, different
      // cause, so the user still learns the run was truncated.
      error += strandedNote(
        remainingAfter(fanOutChain),
        "this run could not hand the chain on. Re-run the workflow for " +
          "the items after this one",
      );
    }
  }

  const execution = await prisma.execution.update({
    where: locate,
    data: {
      status: ExecutionStatus.FAILED,
      error,
      errorStack: stackOf(thrown),
      completedAt: new Date(),
    },
    select: {
      id: true,
      workflow: {
        select: {
          name: true,
          user: { select: { id: true, email: true } },
        },
      },
    },
  });

  // Single capture point for execution failures: this runs for every failed
  // run — node executor errors and engine errors (cycles, load/DB) alike — so
  // reporting here once avoids duplicate Sentry events. Per-node detail (which
  // node, its input) is already persisted via the NodeRecorder.
  logger.error("Workflow execution failed", thrown, {
    executionId: execution.id,
    workflowName: execution.workflow.name,
    userId: execution.workflow.user.id,
  });

  // Best-effort: an email failure (or missing RESEND_API_KEY) must never
  // break the failure handler itself.
  try {
    await sendWorkflowFailureEmail({
      executionId: execution.id,
      workflowName: execution.workflow.name,
      userId: execution.workflow.user.id,
      userEmail: execution.workflow.user.email,
      // The same resolved message the row got, not the raw platform error —
      // the email is often the only thing the user reads, and "function timed
      // out" alone tells them nothing actionable.
      error,
    });
  } catch (err) {
    logger.error("Failed to send workflow failure email", err, {
      executionId: execution.id,
    });
  }

  return { executionId: execution.id, error };
}

/**
 * Best-effort failure alert. Honors the per-user opt-out (default on when no
 * NotificationSettings row exists) and names the offending node when a FAILED
 * NodeExecution exists — degrading gracefully when the run failed before any
 * node ran (e.g. a cyclic workflow). Never throws to its caller.
 *
 * Module-private, as it was before the move. Its only caller is
 * `settleFailedExecution` above, and exporting it would invite a second call
 * path that skips the ordering that function documents.
 */
async function sendWorkflowFailureEmail({
  executionId,
  workflowName,
  userId,
  userEmail,
  error,
}: {
  executionId: string;
  workflowName: string;
  userId: string;
  userEmail: string | null;
  error: string;
}) {
  if (!userEmail) return;

  const settings = await prisma.notificationSettings.findUnique({
    where: { userId },
    select: { notifyOnFailure: true },
  });
  if (settings && settings.notifyOnFailure === false) return;

  const failedNode = await prisma.nodeExecution.findFirst({
    where: { executionId, status: NodeExecutionStatus.FAILED },
    orderBy: { sequence: "desc" },
    select: { nodeName: true, nodeType: true },
  });

  const { subject, html, text } = buildFailureEmail({
    workflowName,
    executionId,
    error,
    failedNode: failedNode
      ? { name: failedNode.nodeName, type: failedNode.nodeType }
      : undefined,
    appUrl: process.env.BETTER_AUTH_URL,
  });

  await sendEmail({ to: userEmail, subject, html, text });
}
