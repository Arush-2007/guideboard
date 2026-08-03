import { NonRetriableError } from "inngest";
import {
  buildFailureEmail,
  resolveFailureCause,
} from "@/features/executions/lib/failure-email";
import type { StepTools } from "@/features/executions/types";
import {
  ExecutionStatus,
  NodeExecutionStatus,
  NodeType,
  type Prisma,
} from "@/generated/prisma";
import {
  deleteBlobsByPrefix,
  getBlobJson,
  isBlobConfigured,
  putBlob,
} from "@/lib/blob";
import { clampJson, isClampedMarker } from "@/lib/clamp-json";
import prisma from "@/lib/db";
import { sendEmail } from "@/lib/email";
import {
  getSheetGrid,
  mergedDataRows,
  SHEETS_READ,
  sheetRange,
} from "@/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { HTTP_TIMEOUT, http, rethrowTimeout } from "@/lib/http";
import { logger } from "@/lib/logger";
import { DEFAULT_ON_ITEM_FAILURE } from "@/lib/multi-match";
import type { RowScope } from "@/lib/sheets-trigger-options";
import { SHEETS_TRIGGER_DEFAULT_ROW_SCOPE } from "@/lib/sheets-trigger-options";
import { fetchNewYoutubeComments } from "@/lib/youtube-comments";
import { inngest } from "./client";
import {
  buildFanOutSeed,
  FAN_OUT_CHAIN_INLINE_LIMIT_BYTES,
  type FanOutChain,
  type FanOutChainBlob,
  fanOutItemIdempotencyKey,
  planChainAdvance,
  planFanOutChain,
  remainingAfter,
  resolveChainSeed,
} from "./fan-out";
import { resolveWorkflowRetries } from "./retry-policy";
import {
  type FanOutDispatcher,
  type NodeRecorder,
  runWorkflowNodes,
} from "./run-workflow";
import { processSchedulePoll } from "./schedule-poll";
import {
  changedFieldNames,
  collectHeadingTexts,
  computeWatchedColumns,
  healIgnoreColumns,
  planHeadingChanges,
  planSheetsPollChanges,
  readSnapshot,
  rowValuesByHeader,
  type SheetsPollSnapshot,
  type SheetsTriggerOn,
  sheetsHeadingIdempotencyKey,
  sheetsPollIdempotencyKey,
  sheetsProjection,
} from "./sheets-poll-diff";
import { sendWorkflowExecution, topologicalSort } from "./utils";

// How many polls of one provider may run at once. Inngest checks this against
// the account's plan ceiling at SYNC time and refuses to register a function
// that declares more — it does not silently clamp — so a value above the plan
// limit fails the whole deploy, not just that function.
//
// Defaults to 5, the Hobby ceiling, so a free-tier install syncs out of the box;
// a paid deployment raises it with POLL_CONCURRENCY. The cap exists to stop one
// slow or failing poll starving the others, not because any particular number is
// meaningful — lowering it costs parallelism, never correctness.
const POLL_CONCURRENCY =
  Number.parseInt(process.env.POLL_CONCURRENCY ?? "", 10) || 5;

/** The Gmail poller's reads — listing and fetching messages changes nothing. */
const GMAIL_READ = {
  integration: "Gmail",
  timeoutClass: "READ",
  idempotent: true,
  hint: "Gmail is slow right now; the next poll will pick these up.",
} as const;

/**
 * Prisma-backed NodeRecorder: writes one NodeExecution row per node, once when
 * the node settles. `input`/`output` are size-capped via `clampJson` here so the
 * engine stays Prisma-free.
 *
 * Takes a BATCH because the engine buffers settled nodes and flushes them inside
 * a step it is already paying for. The per-node `step.run` this replaced cost
 * one durable step per node — seconds of Inngest dispatch latency each, for a row
 * nothing in the run waits on — and it cannot be a step any more regardless,
 * since nodes inside a batched segment are already inside one and steps do not
 * nest.
 *
 * **Idempotence is a hard requirement, not a nicety.** Inngest re-executes the
 * whole handler body on every step boundary, so the engine rebuilds the same
 * buffer each time and can offer the same record repeatedly. Three properties
 * make that safe:
 *
 *  1. Rows already present are filtered out BEFORE the write, so a repeat costs
 *     one indexed lookup instead of re-shipping every clamped context — the
 *     difference between O(K) and O(K²) bytes on the wire for a K-node run.
 *  2. `createMany({ skipDuplicates: true })` backstops that filter against the
 *     `(executionId, nodeId)` unique constraint, so a race cannot duplicate.
 *  3. Because rows are never overwritten, the FIRST write's timestamps survive —
 *     which is what keeps per-node settle times honest even though the write is
 *     deferred. The record carries the moment the engine OBSERVED the node
 *     settle, so flush time never leaks into the data.
 */
function createPrismaNodeRecorder({
  executionId,
}: {
  executionId: string;
}): NodeRecorder {
  return {
    async settledNodeIds(nodeIds) {
      // A FAILED row does not count as settled: a later attempt may re-run that
      // node, and it should publish its status again when it does.
      const rows = await prisma.nodeExecution.findMany({
        where: {
          executionId,
          nodeId: { in: nodeIds },
          status: { not: NodeExecutionStatus.FAILED },
        },
        select: { nodeId: true },
      });
      return new Set(rows.map((r) => r.nodeId));
    },

    async flush(records) {
      if (records.length === 0) return;

      const nodeIds = records.map((r) => r.nodeId);

      // Which of these are already durable? A FAILED row is deliberately NOT
      // counted: it is the one status that can be stale, because a later
      // function attempt may re-run that node and succeed. Everything else is
      // written once and never revised.
      const alreadyWritten = await prisma.nodeExecution.findMany({
        where: {
          executionId,
          nodeId: { in: nodeIds },
          status: { not: NodeExecutionStatus.FAILED },
        },
        select: { nodeId: true },
      });
      const done = new Set(alreadyWritten.map((r) => r.nodeId));
      // A record that FAILED is never filtered out, even when the node already
      // has a SUCCESS row. The reverse transition is real: a batched segment can
      // retry, and a node that passed on attempt 1 can fail on attempt 2 for a
      // genuinely time-dependent reason (a CODE node tripping its 1s interrupt
      // deadline, say). Dropping it would leave the page showing that node
      // SUCCESS while the run failed, and leave the alert email unable to name
      // any node at all.
      const fresh = records.filter(
        (r) => r.status === "FAILED" || !done.has(r.nodeId),
      );
      if (fresh.length === 0) return;

      const prepared = fresh.map((record) => {
        const message =
          record.error instanceof Error
            ? record.error.message
            : record.error != null
              ? String(record.error)
              : null;
        const stack =
          record.error instanceof Error ? (record.error.stack ?? null) : null;
        // Back-dated from the settle time the ENGINE observed, so the row
        // reflects the node's real span regardless of when this flush runs.
        const completedAt = record.completedAt;
        const startedAt = new Date(completedAt.getTime() - record.durationMs);

        // Clamped ONCE and carried to the blob pass below. It was previously
        // recomputed there just to test `isClampedMarker`, which meant a second
        // full serialization of every node's context — on the run's critical
        // path, since this flush runs inside a step the run is waiting on.
        const clampedInput = clampJson(record.input);

        const row = {
          executionId,
          nodeId: record.nodeId,
          nodeType: record.nodeType,
          nodeName: record.nodeName,
          sequence: record.sequence,
          status:
            record.status === "FAILED"
              ? NodeExecutionStatus.FAILED
              : record.status === "SKIPPED"
                ? NodeExecutionStatus.SKIPPED
                : NodeExecutionStatus.SUCCESS,
          input: clampedInput as Prisma.InputJsonValue,
          // Deliberately null on insert. The R2 upload happens AFTER the row
          // exists, so a failed upload can never leave a row pointing at an
          // object that was never stored — replay then refuses cleanly instead
          // of 404ing. See the second pass below.
          inputBlobKey: null,
          output:
            record.output !== undefined
              ? (clampJson(record.output) as Prisma.InputJsonValue)
              : undefined,
          error: message,
          errorStack: stack,
          startedAt,
          completedAt,
          durationMs: record.durationMs,
        };

        return { record, clampedInput, row };
      });

      const rows = prepared.map((p) => p.row);
      const writtenIds = fresh.map((r) => r.nodeId);
      // Nodes whose NEW record is a failure. Their existing row is superseded
      // whatever its status, so it must go — `createMany`'s `skipDuplicates`
      // would otherwise keep the stale SUCCESS and drop the failure.
      const supersededIds = fresh
        .filter((r) => r.status === "FAILED")
        .map((r) => r.nodeId);

      // One transaction: clear rows this insert replaces, then insert. Both
      // deletes are no-ops on the common path, and each can only remove a row
      // the very same statement is about to rewrite.
      await prisma.$transaction([
        prisma.nodeExecution.deleteMany({
          where: {
            executionId,
            OR: [
              // A stale failure from an earlier attempt, now re-run.
              {
                nodeId: { in: writtenIds },
                status: NodeExecutionStatus.FAILED,
              },
              // A row of any status being replaced by a failure.
              { nodeId: { in: supersededIds } },
            ],
          },
        }),
        prisma.nodeExecution.createMany({ data: rows, skipDuplicates: true }),
      ]);

      // Oversized contexts: park the full snapshot in R2 so replay-from-node can
      // seed real data (a truncation marker would silently corrupt the replay),
      // then point the row at it. Only for rows THIS flush inserted, so a
      // rebuilt buffer never re-uploads — the objection that sank an earlier
      // design, where `skipDuplicates` deduped at the database long after the
      // bytes had already gone over the wire.
      //
      // SKIPPED nodes never seed a replay (replayFromNode rejects them), so
      // their snapshots aren't stored. Best-effort throughout: recording must
      // never break a run.
      if (!isBlobConfigured()) return;
      for (const { record, clampedInput } of prepared) {
        if (record.status === "SKIPPED") continue;
        if (!isClampedMarker(clampedInput)) continue;

        const key = `replay-contexts/${executionId}/${record.nodeId}.json`;
        try {
          await putBlob({
            key,
            bytes: Buffer.from(JSON.stringify(record.input)),
            contentType: "application/json",
          });
          await prisma.nodeExecution.update({
            where: {
              executionId_nodeId: { executionId, nodeId: record.nodeId },
            },
            data: { inputBlobKey: key },
            select: { id: true },
          });
        } catch (err) {
          logger.error("Failed to store full input snapshot", err, {
            executionId,
            nodeId: record.nodeId,
          });
        }
      }
    },
  };
}

/**
 * Inngest/blob-backed FanOutDispatcher: starts a fan-out node's CHAIN of child
 * sub-executions — each child a replay-from-node run of the fan-out node +
 * descendants, seeded with one item.
 *
 * Only item 0 is sent here. Each child dispatches the next as it finishes (see
 * `advanceFanOutChain`), which is what makes children run in item order: Inngest
 * gives no ordering guarantee across separate runs, so the previous
 * dispatch-all-at-once landed N events effectively tied and they ran shuffled.
 * Chaining costs no throughput — `executeWorkflow`'s `concurrency: { limit: 1 }`
 * already serialized them — and no extra billed steps, because the advance rides
 * inside the child's existing `update-execution` step.
 *
 * The send happens inside a `step.run` so a retry re-emits it; the child's own
 * `check-idempotency` step then dedupes on the per-item `idempotencyKey`.
 */
function createFanOutDispatcher({
  step,
  executionId,
  workflowId,
}: {
  step: StepTools;
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

        // One blob for the WHOLE chain (not one per item, as the previous
        // dispatch-all design needed), written once and read by each child.
        if (planned.oversized) {
          if (!isBlobConfigured()) {
            throw new NonRetriableError(
              `This fan-out's ${items.length} items are too large to send ` +
                "inline and blob storage (R2) is not configured — set " +
                "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and " +
                "R2_BUCKET so the item list can be offloaded instead of " +
                "exceeding the Inngest event size limit.",
            );
          }
          await putBlob({
            key: planned.blobKey,
            bytes: Buffer.from(JSON.stringify(planned.blob)),
            contentType: "application/json",
          });
        }

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
function strandedNote(count: number, because: string): string {
  if (count <= 0) return "";
  return (
    `\n\nThe remaining ${count} item${count === 1 ? "" : "s"} of this ` +
    `fan-out were not started, because ${because}.`
  );
}

/**
 * Reads a JSON blob, turning any failure into a NonRetriableError that names
 * what could not be loaded. A missing or corrupt blob is a data problem no
 * retry resolves, and both callers (a run's stored context snapshot, and a
 * fan-out chain's item list) want identical handling — so the wrapping lives
 * here rather than being spelled out at each call site.
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
 * Hands a fan-out chain on to its next item. Called from BOTH the success path
 * (inside `update-execution`) and `onFailure` — a failed item must still
 * advance when the policy is "continue", or one bad item silently drops every
 * remaining one. A double advance is harmless: the next child's idempotency key
 * dedupes it.
 *
 * Returns the number of items that will never start, which is non-zero only
 * when a "stop" policy cut the chain short.
 */
async function advanceFanOutChain({
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

/**
 * Best-effort failure alert. Honors the per-user opt-out (default on when no
 * NotificationSettings row exists) and names the offending node when a FAILED
 * NodeExecution exists — degrading gracefully when the run failed before any
 * node ran (e.g. a cyclic workflow). Never throws to its caller.
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

export const executeWorkflow = inngest.createFunction(
  {
    id: "execute-workflow",
    // Dev retries once rather than not at all — see `resolveWorkflowRetries`
    // for why zero made every transient network fault look like a workflow bug.
    // Override with INNGEST_RETRIES.
    retries: resolveWorkflowRetries(),
    // Serialize runs of the same workflow: at most one execution in flight per
    // workflowId. Stops same-workflow triggers (e.g. a form submission and a
    // hand-edit) from interleaving and racing on shared external state, and
    // closes the create-vs-check-idempotency window on trigger bursts. Distinct
    // workflows still run fully in parallel (the key partitions the limit).
    concurrency: { key: "event.data.workflowId", limit: 1 },
    onFailure: async ({ event }) => {
      const inngestEventId = event.data.event.id;
      const platformError = event.data.error.message;
      const { workflowId, fanOutChain } = event.data.event.data as {
        workflowId?: string;
        fanOutChain?: FanOutChain;
      };

      // Did ANY node get as far as recording? Zero rows means the run never
      // reached the engine's own failure path — see `resolveFailureCause`.
      const recordedNodes = await prisma.nodeExecution.count({
        where: { execution: { inngestEventId } },
      });
      let error = resolveFailureCause(recordedNodes, platformError);

      // The failed half of the fan-out chain. This is load-bearing: a child
      // that fails is still the only thing holding the chain, so under the
      // default "continue" policy it MUST hand on, or one bad item silently
      // drops every item after it.
      //
      // Best-effort, like the email below — a send failure must never stop the
      // run from being recorded FAILED. Ordered before the update so a "stop"
      // can name the abandoned items in the same write.
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
            inngestEventId,
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
        where: { inngestEventId },
        data: {
          status: ExecutionStatus.FAILED,
          error,
          errorStack: event.data.error.stack,
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

      // Single capture point for execution failures: onFailure fires for every
      // failed run — node executor errors and engine errors (cycles, load/DB)
      // alike — so reporting here once avoids duplicate Sentry events. Per-node
      // detail (which node, its input) is already persisted via the NodeRecorder.
      logger.error("Workflow execution failed", event.data.error, {
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
    },
  },
  {
    // Realtime publish is provided by realtimeMiddleware() on the inngest client
    // (src/inngest/client.ts), so channels don't need to be declared here. Each
    // executor publishes to its own user-scoped channel, e.g.
    // `anthropicChannel(userId).status(...)`.
    event: "workflows/execute.workflow",
  },
  async ({ event, step, publish }) => {
    const inngestEventId = event.id;
    const {
      workflowId,
      initialData: inlineInitialData,
      initialDataBlobKey,
      idempotencyKey,
      replayFromNodeId,
      replayOfExecutionId,
      fanOutChain,
    } = event.data as {
      workflowId?: string;
      // Keep this loose because this JSON is stored directly in Prisma.
      initialData?: any;
      // Oversized seed contexts travel as a blob key, not inline (event size
      // limits) — hydrated below inside a step. See sendWorkflowExecution.
      initialDataBlobKey?: string;
      idempotencyKey?: string;
      // Replay-from-node: see runWorkflowNodes / sendWorkflowExecution.
      replayFromNodeId?: string;
      replayOfExecutionId?: string;
      // Fan-out chain link: this run processes item `index` and dispatches the
      // next when it finishes. Its seed is DERIVED from the chain rather than
      // passed as initialData. See src/inngest/fan-out.ts.
      fanOutChain?: FanOutChain;
    };

    if (!inngestEventId || !workflowId) {
      throw new NonRetriableError("Event ID or workflow ID is missing");
    }

    if (idempotencyKey) {
      const existing = await step.run("check-idempotency", async () => {
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
        // chain itself (on success or through onFailure). Advancing from here
        // too would race a sibling that is still running, which is exactly the
        // out-of-order dispatch chaining exists to prevent.
        return {
          skipped: true,
          reason: "duplicate",
          existingExecutionId: existing.id,
        };
      }
    }

    // Creates the run's row and resolves the context it starts from. A fan-out
    // child DERIVES its seed from the chain descriptor rather than receiving it
    // as `initialData`, which is what lets each link carry only the items still
    // to do instead of a pre-built seed per item.
    //
    // Folded into this one step on purpose: the derivation is needed here
    // anyway (the row persists the seed as `input`, which is what `rerun`
    // replays), so chaining costs no extra billed Inngest step per child.
    // An INLINE chain carries its own payload, so the seed is a pure function
    // of event data. Derived out here, NOT returned from the step below:
    // Inngest memoizes step output into run state and re-ships it on every
    // later invocation, so returning the seed would put a full copy of the
    // context on the wire once per step boundary — on top of the event that
    // already carries it. Recomputing a shallow spread per invocation is far
    // cheaper than transmitting it.
    const inlineChainSeed =
      fanOutChain && !fanOutChain.chainBlobKey
        ? buildFanOutSeed({
            ...resolveChainSeed(fanOutChain),
            outputKey: fanOutChain.outputKey,
            index: fanOutChain.index,
            total: fanOutChain.total,
          })
        : undefined;

    const { id: executionId, chainSeed: hydratedChainSeed } = await step.run(
      "create-execution",
      async (): Promise<{
        id: string;
        chainSeed?: Record<string, unknown>;
      }> => {
        // Ordinary (non-chain) run: unchanged.
        if (!fanOutChain) {
          const created = await prisma.execution.create({
            data: {
              workflowId,
              inngestEventId,
              idempotencyKey: idempotencyKey ?? null,
              // Persist the trigger payload (or, for a replay, the seeded
              // snapshot) so the run can be re-dispatched verbatim. Blob-seeded
              // runs store a small reference instead of the oversized payload;
              // `rerun` resolves it back to `initialDataBlobKey`.
              input: (initialDataBlobKey
                ? { __blobRef: initialDataBlobKey }
                : (inlineInitialData ?? {})) as Prisma.InputJsonValue,
              // Link a replay back to its origin run; null for ordinary runs.
              replayOfId: replayOfExecutionId ?? null,
            },
            select: { id: true },
          });
          return { id: created.id };
        }

        // upsert, not create, for every chain child: the oversized branch below
        // has a SECOND failable write after the row exists, and Inngest re-runs
        // the whole callback on retry. A plain create would then hit the
        // `inngestEventId` unique constraint and fail identically on every
        // attempt, turning a transient DB blip into a permanently dead fan-out
        // item. Re-finding the row it already made is the recovery.
        const created = await prisma.execution.upsert({
          where: { inngestEventId },
          create: {
            workflowId,
            inngestEventId,
            idempotencyKey: idempotencyKey ?? null,
            // The inline seed is known already and is provably under the event
            // budget, so it is stored verbatim in ONE write — no clamp (it
            // could never fire) and no backfill.
            input: (inlineChainSeed ?? {}) as Prisma.InputJsonValue,
            replayOfId: replayOfExecutionId ?? null,
          },
          update: {},
          select: { id: true },
        });

        if (inlineChainSeed) return { id: created.id };

        // Oversized chain: the item list lives in a blob. The row was created
        // BEFORE this read for the same reason `hydrate-initial-data` runs after
        // create-execution — a hydration failure has to land on a *visible*
        // FAILED run, and onFailure updates by `inngestEventId`, so the row must
        // already exist. Hence the second write below, on this path only.
        const blob = await hydrateBlobJson<FanOutChainBlob>(
          fanOutChain.chainBlobKey as string,
          "fan-out item list",
        );

        const seed = buildFanOutSeed({
          ...resolveChainSeed(fanOutChain, blob),
          outputKey: fanOutChain.outputKey,
          index: fanOutChain.index,
          total: fanOutChain.total,
        });

        // Clamped, not blob-referenced: a chain goes to a blob because the
        // whole ITEM LIST is large, which says nothing about one item's seed —
        // 1000 small rows produce a big list and small seeds. Budgeted against
        // the CHAIN's inline limit rather than `clampJson`'s 32 KB default, so
        // a seed in the 32-128 KB band persists intact; storing a truncation
        // marker there would make `rerun` re-dispatch the workflow with
        // `{__truncated}` as its context.
        await prisma.execution.update({
          where: { id: created.id },
          data: {
            input: clampJson(
              seed,
              FAN_OUT_CHAIN_INLINE_LIMIT_BYTES,
            ) as Prisma.InputJsonValue,
          },
          select: { id: true },
        });

        return { id: created.id, chainSeed: seed };
      },
    );

    const chainSeed = inlineChainSeed ?? hydratedChainSeed;

    // Hydrate a blob-stored seed context. Runs AFTER create-execution so a
    // missing/unreadable blob fails a *visible* run (onFailure marks the row
    // FAILED); before the row exists, onFailure's update-by-eventId would
    // itself throw and the failure would be invisible. Step outputs already
    // carry full contexts between nodes, so pulling the snapshot inside a step
    // adds no new size bound. A bad blob is a data problem a retry won't fix.
    // A fan-out child's seed is already resolved (derived inline above, or
    // hydrated inside create-execution), so there is nothing left to fetch.
    const initialData: Record<string, unknown> | undefined =
      chainSeed ??
      (initialDataBlobKey
        ? await step.run("hydrate-initial-data", () =>
            hydrateBlobJson<Record<string, unknown>>(
              initialDataBlobKey,
              "stored context snapshot",
            ),
          )
        : inlineInitialData);

    const { sortedNodes, connections, userId } = await step.run(
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

    // Run each node in topological order, threading context from one to the
    // next and following only active branches. The recorder writes a
    // NodeExecution row per node for observability.
    const context = await runWorkflowNodes({
      sortedNodes,
      connections,
      userId,
      executionId,
      initialData,
      step,
      publish,
      recorder: createPrismaNodeRecorder({ executionId }),
      fanOutDispatcher: createFanOutDispatcher({
        step,
        executionId,
        workflowId,
      }),
      replayFromNodeId,
    });

    await step.run("update-execution", async () => {
      await prisma.execution.update({
        where: { inngestEventId, workflowId },
        data: {
          status: ExecutionStatus.SUCCESS,
          completedAt: new Date(),
          output: context as Prisma.InputJsonObject,
        },
      });

      // Hand the fan-out chain to its next item. Deliberately inside THIS step
      // rather than one of its own: Inngest bills per step, and a dedicated
      // advance step would add one per child for no behavioural gain. Safe on
      // retry — the update above is idempotent and the send below is deduped by
      // the next item's idempotency key.
      //
      // The failed-item counterpart lives in onFailure; between them, every
      // terminal outcome of a child advances the chain (or deliberately ends
      // it), so it can never stall silently.
      if (fanOutChain) {
        await advanceFanOutChain({
          chain: fanOutChain,
          workflowId,
          failed: false,
        });
      }

      return { advanced: Boolean(fanOutChain) };
    });

    return {
      workflowId,
      result: context,
    };
  },
);

// Dispatcher for every webhook-less trigger: enumerates poll rows (ids only)
// and fans out one `polls/<provider>.check` event each. Rows are provisioned
// and cleaned up by `syncTriggerPollsForWorkflow`
// (src/lib/workflow-persistence.ts) on every workflow create/edit, so each row
// here corresponds to a live trigger. The per-poll work (external API calls,
// workflow dispatch, lastChecked update) lives in the matching `handle*Poll`,
// each with its own retries + concurrency cap so one poll can't block another.
//
// Deliberately ONE function running ONE step for all three providers, rather
// than the three near-identical dispatchers this replaces. A cron tick is
// billed whether or not it finds work, and Inngest bills per step: three empty
// `*/5` dispatchers cost three times one combined empty tick — roughly 26k
// billed steps a month against 9k — for byte-identical behaviour. The three
// queries share a single `step.run` for that same reason; splitting them into a
// step apiece would hand the saving straight back.
//
// Each provider's event name is welded to the query that feeds it, so the two
// can't drift out of step the way a pair of parallel literals would.
const TRIGGER_POLL_SOURCES = [
  {
    event: "polls/gmail.check",
    list: () => prisma.gmailPoll.findMany({ select: { id: true } }),
  },
  {
    event: "polls/google-sheets.check",
    list: () => prisma.googleSheetsPoll.findMany({ select: { id: true } }),
  },
  {
    event: "polls/youtube.check",
    list: () => prisma.youtubeCommentPoll.findMany({ select: { id: true } }),
  },
] as const;

export const pollTriggers = inngest.createFunction(
  { id: "poll-triggers", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const { events, failed } = await step.run("fetch-poll-ids", async () => {
      // `allSettled`, not `all`: sharing one step means one rejection would
      // otherwise take the other two providers' dispatch down with it, which is
      // the isolation the three separate functions used to give for free. A
      // provider that fails is skipped for this tick alone and recovers on the
      // next one five minutes later — cheaper than losing all three. Retrying
      // instead wouldn't buy that back: with `retries: 1` a persistent fault
      // still ends with every provider dropped.
      const settled = await Promise.allSettled(
        TRIGGER_POLL_SOURCES.map((source) => source.list()),
      );

      const events: { name: string; data: { pollId: string } }[] = [];
      const failed: string[] = [];

      settled.forEach((result, index) => {
        const { event } = TRIGGER_POLL_SOURCES[index];
        if (result.status === "rejected") {
          failed.push(event);
          logger.error("Trigger poll lookup failed", result.reason, { event });
          return;
        }
        for (const poll of result.value) {
          events.push({ name: event, data: { pollId: poll.id } });
        }
      });

      return { events, failed };
    });

    // `failed` rides along on both returns so a degraded tick is visible in the
    // run output, not only in the logs.
    if (events.length === 0) return { dispatched: 0, failed };

    await step.sendEvent("dispatch-trigger-polls", events);

    return { dispatched: events.length, failed };
  },
);

// Handler: processes a single YouTube comment poll. Fetches only this
// workflow's trigger node (not every node of every workflow), runs with its
// own retries + concurrency cap so one poll's failure/slowness can't block the
// rest. Duplicate workflow runs are prevented by the `youtube:<commentId>`
// idempotency key on each execution.
export const handleYoutubePoll = inngest.createFunction(
  {
    id: "handle-youtube-poll",
    retries: 1,
    concurrency: { limit: POLL_CONCURRENCY },
  },
  { event: "polls/youtube.check" },
  async ({ event, step }) => {
    const { pollId } = event.data as { pollId: string };

    await step.run("process-youtube-poll", async () => {
      const poll = await prisma.youtubeCommentPoll.findUnique({
        where: { id: pollId },
        include: {
          workflow: {
            include: {
              nodes: { where: { type: NodeType.YOUTUBE_COMMENT_TRIGGER } },
            },
          },
        },
      });
      if (!poll) return;

      const triggerNode = poll.workflow.nodes[0];
      if (!triggerNode) return;

      const comments = await fetchNewYoutubeComments(
        poll.userId,
        poll.videoId,
        new Date(poll.lastChecked),
      );

      for (const comment of comments) {
        const nodeData = triggerNode.data as { keywordFilter?: string } | null;
        if (nodeData?.keywordFilter) {
          if (
            !comment.commentText
              .toLowerCase()
              .includes(nodeData.keywordFilter.toLowerCase())
          ) {
            continue;
          }
        }

        await sendWorkflowExecution({
          workflowId: poll.workflowId,
          initialData: {
            commentId: comment.commentId,
            commentText: comment.commentText,
            commenterName: comment.commenterName,
            videoId: comment.videoId,
          },
          idempotencyKey: `youtube:${comment.commentId}`,
        });
      }

      await prisma.youtubeCommentPoll.update({
        where: { id: poll.id },
        data: { lastChecked: new Date() },
      });
    });
  },
);

type GmailListResponse = {
  messages?: Array<{ id: string }>;
};

type GmailMessageResponse = {
  id: string;
  snippet?: string;
  payload?: {
    headers?: Array<{
      name?: string;
      value?: string;
    }>;
  };
};

type GoogleSheetsValuesResponse = {
  values?: string[][];
};

function getHeaderValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string {
  if (!headers) return "";
  const found = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

// Handler: processes a single Gmail poll (token refresh + unread scan + N
// metadata fetches). Isolated retries + concurrency cap; duplicate runs are
// prevented by the `gmail:<messageId>` idempotency key and the mark-as-read.
export const handleGmailPoll = inngest.createFunction(
  {
    id: "handle-gmail-poll",
    retries: 1,
    concurrency: { limit: POLL_CONCURRENCY },
  },
  { event: "polls/gmail.check" },
  async ({ event, step }) => {
    const { pollId } = event.data as { pollId: string };

    await step.run("process-gmail-poll", async () => {
      const poll = await prisma.gmailPoll.findUnique({
        where: { id: pollId },
        select: { id: true, workflowId: true, userId: true },
      });
      if (!poll) return;

      let accessToken: string;
      try {
        accessToken = await refreshGoogleTokenIfNeeded(poll.userId);
      } catch {
        return;
      }

      const headers = {
        Authorization: `Bearer ${accessToken}`,
      };

      const list = await http
        .get("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
          headers,
          searchParams: {
            q: "is:unread",
            maxResults: "10",
          },
          timeout: HTTP_TIMEOUT.READ,
        })
        .json<GmailListResponse>()
        .catch(rethrowTimeout(GMAIL_READ));

      for (const msg of list.messages ?? []) {
        const metadataParams = new URLSearchParams();
        metadataParams.set("format", "metadata");
        metadataParams.append("metadataHeaders", "Subject");
        metadataParams.append("metadataHeaders", "From");

        const detail = await http
          .get(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`,
            {
              headers,
              searchParams: metadataParams,
              timeout: HTTP_TIMEOUT.READ,
            },
          )
          .json<GmailMessageResponse>()
          .catch(rethrowTimeout(GMAIL_READ));

        const subject = getHeaderValue(detail.payload?.headers, "Subject");
        const from = getHeaderValue(detail.payload?.headers, "From");
        const snippet = detail.snippet ?? "";

        await sendWorkflowExecution({
          workflowId: poll.workflowId,
          initialData: {
            gmail: {
              messageId: msg.id,
              subject,
              from,
              snippet,
            },
          },
          idempotencyKey: `gmail:${msg.id}`,
        });

        await http
          .post(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/modify`,
            {
              headers: {
                ...headers,
                "Content-Type": "application/json",
              },
              json: {
                removeLabelIds: ["UNREAD"],
              },
              timeout: HTTP_TIMEOUT.WRITE,
            },
          )
          .catch(
            rethrowTimeout({
              integration: "Gmail",
              timeoutClass: "WRITE",
              // Removing a label already removed is a no-op — this is a set
              // operation, not an append, so repeating it is safe.
              idempotent: true,
              hint: "Gmail is slow right now; the message stays unread until this succeeds.",
            }),
          );
      }

      await prisma.gmailPoll.update({
        where: { id: poll.id },
        data: { lastChecked: new Date() },
      });
    });
  },
);

/**
 * Rewrites the Sheets trigger node's `ignoreColumns` after the poller followed a
 * renamed column, keeping the config the user sees (and the copy `syncTriggerPolls`
 * re-denormalizes) pointed at the column they actually picked.
 *
 * Best-effort: the poll row is already healed, so a failure here costs a stale
 * dialog label and a re-heal on the next poll, not a missed trigger — never a
 * reason to fail the run and re-fire the executions this poll already sent.
 */
async function persistHealedIgnoreColumns(
  workflowId: string,
  ignoreColumns: string[],
) {
  try {
    const node = await prisma.node.findFirst({
      where: { workflowId, type: NodeType.GOOGLE_SHEETS_TRIGGER },
      select: { id: true, data: true },
    });
    if (!node) return;

    const data =
      node.data && typeof node.data === "object" && !Array.isArray(node.data)
        ? (node.data as Prisma.JsonObject)
        : {};

    await prisma.node.update({
      where: { id: node.id },
      data: { data: { ...data, ignoreColumns } },
    });
  } catch (err) {
    logger.error("Failed to heal Sheets trigger ignoreColumns", err, {
      workflowId,
    });
  }
}

// Handler: processes a single Google Sheets poll. Emits one execution per
// change the poll's `triggerOn` watches: appended rows (row count grew) and/or
// edited rows (a stored per-position content hash changed). Isolated retries +
// concurrency cap; duplicate runs are prevented by the
// `google_sheets:<spreadsheetId>:<rowIndex>[:<hash>]` idempotency key.
export const handleGoogleSheetsPoll = inngest.createFunction(
  {
    id: "handle-google-sheets-poll",
    retries: 1,
    concurrency: { limit: POLL_CONCURRENCY },
  },
  { event: "polls/google-sheets.check" },
  async ({ event, step }) => {
    const { pollId } = event.data as { pollId: string };

    await step.run("process-google-sheets-poll", async () => {
      const poll = await prisma.googleSheetsPoll.findUnique({
        where: { id: pollId },
        select: {
          id: true,
          workflowId: true,
          userId: true,
          spreadsheetId: true,
          sheetName: true,
          lastRowCount: true,
          rowHashes: true,
          triggerOn: true,
          rowScope: true,
          ignoreColumns: true,
          lastChecked: true,
        },
      });
      if (!poll) return;

      let accessToken: string;
      try {
        accessToken = await refreshGoogleTokenIfNeeded(poll.userId);
      } catch {
        return;
      }

      const a1Range = sheetRange(poll.sheetName, "A:ZZ");
      // The SAME wide A:ZZ read that died on ky's 10s default — and this one is on a
      // 5-minute cron, so a silent timeout here means the trigger just stops firing.
      const valuesResult = await http
        .get(
          `https://sheets.googleapis.com/v4/spreadsheets/${poll.spreadsheetId}/values/${encodeURIComponent(a1Range)}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            timeout: HTTP_TIMEOUT.READ,
          },
        )
        .json<GoogleSheetsValuesResponse>()
        .catch(
          rethrowTimeout({ integration: "Google Sheets", ...SHEETS_READ }),
        );

      const rows = valuesResult.values ?? [];
      const currentRowCount = rows.length;
      const header = rows[0] ?? [];

      // `readSnapshot` owns the persisted shape (incl. the legacy per-row forms).
      const {
        cellHashes: oldCellHashes,
        projection: oldProjection,
        header: lastHeader,
        headings: lastHeadings,
      } = readSnapshot(poll.rowHashes);

      // Ignored columns are stored as header names; resolve against the current
      // header row (so scoping tracks a column even if it was reordered) and
      // watch everything else. Empty = watch the whole row.
      const storedIgnoreNames = Array.isArray(poll.ignoreColumns)
        ? (poll.ignoreColumns as string[])
        : [];
      // Renaming an ignored column would otherwise stop its stored name from
      // matching, silently un-ignoring it. Follow the rename BEFORE scoping, so
      // this poll already honours the setting rather than losing it for a poll
      // (and widening the watched set, which would suppress its edits too).
      const healedIgnoreNames = lastHeader
        ? healIgnoreColumns(storedIgnoreNames, lastHeader, header)
        : null;
      const ignoreNames = healedIgnoreNames ?? storedIgnoreNames;

      const watchColumns = computeWatchedColumns(header, ignoreNames);
      const newProjection = sheetsProjection(header, watchColumns);
      const rowScope =
        (poll.rowScope as RowScope) ?? SHEETS_TRIGGER_DEFAULT_ROW_SCOPE;

      // Which rows are HEADINGS — merged section titles. The values endpoint
      // can't say (a merge is grid metadata), so this is a second request.
      //
      // Skipped entirely under "all", which draws no distinction and so needs no
      // merges. Combined with the legacy default above, a trigger saved before
      // headings existed keeps making exactly ONE request per poll; only a user
      // who opts into a heading-aware scope pays for the second.
      //
      // Left to throw on failure: without merges we can't tell a heading from a
      // data row, and firing the wrong events is worse than a 5-minute retry.
      const headingRows = new Set<number>();
      if (rowScope !== "all") {
        const grid = await getSheetGrid({
          accessToken,
          spreadsheetId: poll.spreadsheetId,
          sheetName: poll.sheetName,
          includeMerges: true,
        });
        // `mergedDataRows` keys by DATA-row index (header excluded), while this
        // poller indexes `rows` from the header at 0. Off by exactly one, and
        // silently wrong if conflated — convert once, here.
        for (const dataRow of mergedDataRows(grid.merges).keys()) {
          headingRows.add(dataRow + 1);
        }
      }
      const newHeadings = collectHeadingTexts(rows, headingRows);

      const { changes, newCellHashes } = planSheetsPollChanges({
        rows,
        lastRowCount: poll.lastRowCount,
        // Null until the first poll seeds it. The first poll is a baseline that
        // fires nothing, so attaching the trigger never backfills existing rows.
        oldCellHashes,
        triggerOn: poll.triggerOn as SheetsTriggerOn,
        watchColumns,
        oldProjection,
        newProjection,
        rowScope,
        headingRows,
      });

      // The poll's prior lastChecked: stable across retries of this poll,
      // distinct on the next one, so a value changed back later fires again.
      const pollToken = String(poll.lastChecked.getTime());

      // The heading half. Deliberately NOT gated on the projection guard that
      // suppresses row edits: a heading's text lives in column A and has nothing
      // to do with the watched-column projection, so an unrelated column change
      // must not swallow a retitled section.
      if (rowScope === "headings") {
        for (const change of planHeadingChanges(lastHeadings, newHeadings)) {
          await sendWorkflowExecution({
            workflowId: poll.workflowId,
            initialData: {
              googleSheets: {
                spreadsheetId: poll.spreadsheetId,
                sheetName: poll.sheetName,
                changeType: "heading_updated",
                heading: change.heading,
                previousHeading: change.previousHeading,
                // No columns changed — a heading is one merged cell, not a row
                // of fields. Both keys stay present so a downstream template
                // referencing them resolves to "" instead of breaking.
                changedFields: "",
                values: {},
              },
            },
            idempotencyKey: sheetsHeadingIdempotencyKey({
              spreadsheetId: poll.spreadsheetId,
              rowIndex: change.rowIndex,
              pollToken,
            }),
          });
        }
      }

      for (const { rowIndex, changeType, changedColumns } of changes) {
        const row = rows[rowIndex - 1] ?? [];
        await sendWorkflowExecution({
          workflowId: poll.workflowId,
          initialData: {
            googleSheets: {
              spreadsheetId: poll.spreadsheetId,
              sheetName: poll.sheetName,
              changeType,
              // The column NAMES that changed, as plain text ("Status, Amount").
              // Empty for an added row (nothing to diff against).
              changedFields: changedFieldNames(header, changedColumns).join(
                ", ",
              ),
              // Cells keyed by column name, so a downstream node picks
              // `googleSheets.values.<Header>` instead of a positional index.
              values: rowValuesByHeader(header, row),
            },
          },
          idempotencyKey: sheetsPollIdempotencyKey({
            spreadsheetId: poll.spreadsheetId,
            rowIndex,
            changeType,
            row,
            pollToken,
          }),
        });
      }

      await prisma.googleSheetsPoll.update({
        where: { id: poll.id },
        data: {
          lastRowCount: currentRowCount,
          // Snapshot = the hashes, the projection they were computed under (so
          // the next poll can tell whether that projection still holds), the
          // header they were read under (so it can spot a rename), and each
          // heading's text (so it can spot a retitled section).
          rowHashes: {
            sig: newProjection.names,
            cols: newProjection.cols,
            header,
            headings: newHeadings,
            cellHashes: newCellHashes,
          } satisfies SheetsPollSnapshot,
          ...(healedIgnoreNames ? { ignoreColumns: healedIgnoreNames } : {}),
          lastChecked: new Date(),
        },
      });

      // The poll row is a denormalized copy — `syncTriggerPolls` rewrites it from
      // the trigger node's `data` on every workflow save, so healing only the copy
      // would be undone by the next save (and leave the dialog showing the old
      // name). Update the source of truth too.
      if (healedIgnoreNames) {
        await persistHealedIgnoreColumns(poll.workflowId, healedIgnoreNames);
      }
    });
  },
);

// How often to look for due schedules. Deployment-configurable because this
// tick is billed whether or not anything is due: an installation with no
// SCHEDULE_TRIGGER workflows pays ~43k empty executions a month at the default.
//
// The default stays every-minute so minute-grained crons fire on time out of
// the box. A deployment whose schedules are coarse — or absent — sets
// SCHEDULE_POLL_CRON="*/5 * * * *" and pays a fifth of that. Note this interval
// caps granularity: a schedule can only fire as precisely as the poll that
// finds it.
//
// `?.trim() ||`, not `??`: setting an env var to an empty value is the ordinary
// way to unset one, and `??` only falls back on undefined — so "" (or "  ")
// would reach createFunction as an invalid cron. That doesn't just break
// schedules: every function is registered through the single serve() handler in
// app/api/inngest/route.ts, so one bad cron takes executeWorkflow and every
// other poller down with it.
const SCHEDULE_POLL_CRON =
  process.env.SCHEDULE_POLL_CRON?.trim() || "* * * * *";

// Dispatcher: scans for SchedulePoll rows whose `nextRunAt` is due (indexed on
// `nextRunAt`, so this is O(due) not O(all)) and fans out one
// `polls/schedule.check` event per row. Per-poll work (dispatch + advance)
// lives in `handleSchedulePoll`.
export const pollSchedules = inngest.createFunction(
  { id: "poll-schedules", retries: 1 },
  { cron: SCHEDULE_POLL_CRON },
  async ({ step }) => {
    const polls = await step.run("fetch-due-schedule-poll-ids", async () => {
      return prisma.schedulePoll.findMany({
        where: { nextRunAt: { lte: new Date() } },
        select: { id: true },
      });
    });

    if (polls.length === 0) return { dispatched: 0 };

    await step.sendEvent(
      "dispatch-schedule-polls",
      polls.map((poll) => ({
        name: "polls/schedule.check",
        data: { pollId: poll.id },
      })),
    );

    return { dispatched: polls.length };
  },
);

// Handler: dispatches the due workflow and advances `nextRunAt`. Isolated
// retries + concurrency cap so one slow schedule can't block the rest; the
// `schedule:<pollId>:<scheduledISO>` idempotency key prevents double-fire
// across overlapping ticks. Logic lives in `processSchedulePoll` so it's
// testable without an Inngest runtime.
export const handleSchedulePoll = inngest.createFunction(
  {
    id: "handle-schedule-poll",
    retries: 1,
    concurrency: { limit: POLL_CONCURRENCY },
  },
  { event: "polls/schedule.check" },
  async ({ event, step }) => {
    const { pollId } = event.data as { pollId: string };
    await step.run("process-schedule-poll", () => processSchedulePoll(pollId));
  },
);

export const pruneOldExecutions = inngest.createFunction(
  { id: "prune-old-executions", retries: 0 },
  { cron: "0 3 * * *" }, // 3 AM UTC daily
  async ({ step }) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Bounded batch so one giant backlog can't blow the step; the daily cron
    // drains any remainder on subsequent runs. userId is needed to address the
    // per-user conversions prefix.
    const prunable = await step.run("find-prunable-executions", async () => {
      return prisma.execution.findMany({
        where: { startedAt: { lt: cutoff } },
        select: { id: true, workflow: { select: { userId: true } } },
        take: 1000,
      });
    });

    if (prunable.length === 0) {
      return { deletedCount: 0, cutoff: cutoff.toISOString() };
    }

    // Row deletion (below) is what enforces retention; blob GC is best-effort
    // so an R2 hiccup never blocks pruning. Blobs are deleted first — their
    // lifetime must not exceed the rows that reference them, and a failed
    // prefix is retried implicitly if row deletion also fails this run.
    if (isBlobConfigured()) {
      await step.run("delete-execution-blobs", async () => {
        let deleted = 0;
        for (const execution of prunable) {
          const prefixes = [
            `replay-contexts/${execution.id}/`,
            `conversions/${execution.workflow.userId}/${execution.id}/`,
          ];
          for (const prefix of prefixes) {
            try {
              deleted += await deleteBlobsByPrefix(prefix);
            } catch (err) {
              logger.error("Failed to prune execution blobs", err, {
                executionId: execution.id,
                prefix,
              });
            }
          }
        }
        return { deleted };
      });
    }

    const result = await step.run("delete-old-executions", async () => {
      return prisma.execution.deleteMany({
        where: { id: { in: prunable.map((e) => e.id) } },
      });
    });

    return { deletedCount: result.count, cutoff: cutoff.toISOString() };
  },
);
