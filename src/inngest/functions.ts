import { NonRetriableError } from "inngest";
import { buildFailureEmail } from "@/features/executions/lib/failure-email";
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
  headingDataRows,
  SHEETS_READ,
  sheetRange,
} from "@/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { HTTP_TIMEOUT, http, rethrowTimeout } from "@/lib/http";
import { logger } from "@/lib/logger";
import type { RowScope } from "@/lib/sheet-heading";
import { SHEETS_TRIGGER_DEFAULT_ROW_SCOPE } from "@/lib/sheets-trigger-options";
import { fetchNewYoutubeComments } from "@/lib/youtube-comments";
import { inngest } from "./client";
import { planFanOutDispatches } from "./fan-out";
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

/** The Gmail poller's reads — listing and fetching messages changes nothing. */
const GMAIL_READ = {
  integration: "Gmail",
  timeoutClass: "READ",
  idempotent: true,
  hint: "Gmail is slow right now; the next poll will pick these up.",
} as const;

/**
 * Prisma-backed NodeRecorder: writes one NodeExecution row per node, once when
 * the node settles, wrapped in a stable-id `step.run` so Inngest checkpoints it
 * and retries stay idempotent. One write-on-settle (vs a RUNNING insert + an
 * update) halves the durable steps and DB writes per node and leaves no orphan
 * RUNNING rows. `input`/`output` are size-capped via `clampJson` here so the
 * engine stays Prisma-free.
 */
function createPrismaNodeRecorder({
  step,
  executionId,
}: {
  step: StepTools;
  executionId: string;
}): NodeRecorder {
  return {
    async record({
      nodeId,
      nodeType,
      nodeName,
      sequence,
      status,
      input,
      output,
      error,
      durationMs,
    }) {
      const message =
        error instanceof Error
          ? error.message
          : error != null
            ? String(error)
            : null;
      const stack = error instanceof Error ? (error.stack ?? null) : null;
      // startedAt is back-dated from the settle time so the row reflects the
      // node's real span; durationMs is the source of truth either way.
      const completedAt = new Date();
      const startedAt = new Date(completedAt.getTime() - durationMs);

      await step.run(`node-record:${nodeId}`, async () => {
        const clampedInput = clampJson(input);

        // When the inline snapshot had to be truncated, park the full context
        // in R2 so replay-from-node can still seed real data (a marker context
        // would silently corrupt the replay). The key is deterministic per
        // (execution, node) so a retried step overwrites its own object. It
        // assumes one run per node per execution (true today, like
        // replayFromNode's snapshot pick) — a future loops feature must add
        // `sequence` to the key or later iterations overwrite earlier ones.
        // Best-effort: recording must never break a run — on failure (or with
        // R2 unconfigured) the key stays null and replay refuses instead.
        // SKIPPED nodes never seed a replay (replayFromNode rejects them), so
        // their snapshots aren't stored — otherwise a replay would re-upload
        // the same oversized context once per skipped upstream node.
        let inputBlobKey: string | null = null;
        if (
          status !== "SKIPPED" &&
          isClampedMarker(clampedInput) &&
          isBlobConfigured()
        ) {
          const key = `replay-contexts/${executionId}/${nodeId}.json`;
          try {
            await putBlob({
              key,
              bytes: Buffer.from(JSON.stringify(input)),
              contentType: "application/json",
            });
            inputBlobKey = key;
          } catch (err) {
            logger.error("Failed to store full input snapshot", err, {
              executionId,
              nodeId,
            });
          }
        }

        return prisma.nodeExecution.create({
          data: {
            executionId,
            nodeId,
            nodeType,
            nodeName,
            sequence,
            status:
              status === "FAILED"
                ? NodeExecutionStatus.FAILED
                : status === "SKIPPED"
                  ? NodeExecutionStatus.SKIPPED
                  : NodeExecutionStatus.SUCCESS,
            input: clampedInput as Prisma.InputJsonValue,
            inputBlobKey,
            output:
              output !== undefined
                ? (clampJson(output) as Prisma.InputJsonValue)
                : undefined,
            error: message,
            errorStack: stack,
            startedAt,
            completedAt,
            durationMs,
          },
          select: { id: true },
        });
      });
    },
  };
}

/**
 * Inngest/blob-backed FanOutDispatcher: turns a fan-out node's items into one
 * child sub-execution each — a replay-from-node run of the fan-out node +
 * descendants, seeded with the per-item payload. All sends happen inside ONE
 * `step.run` so a retried step re-emits every item; the children's own
 * `check-idempotency` step then dedupes on the per-item `idempotencyKey`. Safe
 * because same-workflow runs serialize under `executeWorkflow`'s concurrency
 * limit, so no duplicate child can slip through concurrently.
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
    async dispatch({ nodeId, outputKey, context, items }) {
      await step.run(`fan-out:${nodeId}`, async () => {
        const plans = planFanOutDispatches({
          items,
          context,
          outputKey,
          executionId,
          nodeId,
        });

        // Sequential so an oversized-but-unconfigured item throws before later
        // sends fire, and so retries re-walk the same order deterministically.
        for (const plan of plans) {
          if (plan.oversized) {
            if (!isBlobConfigured()) {
              throw new NonRetriableError(
                `Fan-out item ${plan.index} is too large to send inline and ` +
                  "blob storage (R2) is not configured — set R2_ACCOUNT_ID, " +
                  "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET so " +
                  "oversized item contexts can be offloaded instead of " +
                  "exceeding the Inngest event size limit.",
              );
            }
            await putBlob({
              key: plan.blobKey,
              bytes: Buffer.from(JSON.stringify(plan.seeded)),
              contentType: "application/json",
            });
            await sendWorkflowExecution({
              workflowId,
              initialDataBlobKey: plan.blobKey,
              replayFromNodeId: nodeId,
              replayOfExecutionId: executionId,
              idempotencyKey: plan.idempotencyKey,
            });
          } else {
            await sendWorkflowExecution({
              workflowId,
              initialData: plan.seeded,
              replayFromNodeId: nodeId,
              replayOfExecutionId: executionId,
              idempotencyKey: plan.idempotencyKey,
            });
          }
        }

        return { dispatched: plans.length };
      });
    },
  };
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
    retries: process.env.NODE_ENV === "production" ? 3 : 0,
    // Serialize runs of the same workflow: at most one execution in flight per
    // workflowId. Stops same-workflow triggers (e.g. a form submission and a
    // hand-edit) from interleaving and racing on shared external state, and
    // closes the create-vs-check-idempotency window on trigger bursts. Distinct
    // workflows still run fully in parallel (the key partitions the limit).
    concurrency: { key: "event.data.workflowId", limit: 1 },
    onFailure: async ({ event }) => {
      const execution = await prisma.execution.update({
        where: { inngestEventId: event.data.event.id },
        data: {
          status: ExecutionStatus.FAILED,
          error: event.data.error.message,
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
          error: event.data.error.message,
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
        return {
          skipped: true,
          reason: "duplicate",
          existingExecutionId: existing.id,
        };
      }
    }

    const { id: executionId } = await step.run("create-execution", async () => {
      return prisma.execution.create({
        data: {
          workflowId,
          inngestEventId,
          idempotencyKey: idempotencyKey ?? null,
          // Persist the trigger payload (or, for a replay, the seeded snapshot)
          // so the run can be re-dispatched verbatim. Blob-seeded runs store a
          // small reference instead of the oversized payload; `rerun` resolves
          // it back to `initialDataBlobKey`.
          input: (initialDataBlobKey
            ? { __blobRef: initialDataBlobKey }
            : (inlineInitialData ?? {})) as Prisma.InputJsonValue,
          // Link a replay back to its origin run; null for ordinary runs.
          replayOfId: replayOfExecutionId ?? null,
        },
        select: { id: true },
      });
    });

    // Hydrate a blob-stored seed context. Runs AFTER create-execution so a
    // missing/unreadable blob fails a *visible* run (onFailure marks the row
    // FAILED); before the row exists, onFailure's update-by-eventId would
    // itself throw and the failure would be invisible. Step outputs already
    // carry full contexts between nodes, so pulling the snapshot inside a step
    // adds no new size bound. A bad blob is a data problem a retry won't fix.
    const initialData: Record<string, unknown> | undefined = initialDataBlobKey
      ? await step.run("hydrate-initial-data", async () => {
          try {
            return (await getBlobJson(initialDataBlobKey)) as Record<
              string,
              unknown
            >;
          } catch (err) {
            throw new NonRetriableError(
              `Failed to load the stored context snapshot (${initialDataBlobKey}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        })
      : inlineInitialData;

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
      recorder: createPrismaNodeRecorder({ step, executionId }),
      fanOutDispatcher: createFanOutDispatcher({
        step,
        executionId,
        workflowId,
      }),
      replayFromNodeId,
    });

    await step.run("update-execution", async () => {
      return prisma.execution.update({
        where: { inngestEventId, workflowId },
        data: {
          status: ExecutionStatus.SUCCESS,
          completedAt: new Date(),
          output: context as Prisma.InputJsonObject,
        },
      });
    });

    return {
      workflowId,
      result: context,
    };
  },
);

// Dispatcher: enumerates poll rows (ids only) and fans out one
// `polls/youtube.check` event per row. The per-poll work (external API calls,
// workflow dispatch, lastChecked update) lives in `handleYoutubePoll`, which
// runs with its own retries + concurrency cap so one poll can't block another.
export const pollYoutubeComments = inngest.createFunction(
  { id: "poll-youtube-comments", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const polls = await step.run("fetch-poll-ids", async () => {
      return prisma.youtubeCommentPoll.findMany({ select: { id: true } });
    });

    if (polls.length === 0) return { dispatched: 0 };

    await step.sendEvent(
      "dispatch-youtube-polls",
      polls.map((poll) => ({
        name: "polls/youtube.check",
        data: { pollId: poll.id },
      })),
    );

    return { dispatched: polls.length };
  },
);

// Handler: processes a single YouTube comment poll. Fetches only this
// workflow's trigger node (not every node of every workflow), runs with its
// own retries + concurrency cap so one poll's failure/slowness can't block the
// rest. Duplicate workflow runs are prevented by the `youtube:<commentId>`
// idempotency key on each execution.
export const handleYoutubePoll = inngest.createFunction(
  { id: "handle-youtube-poll", retries: 1, concurrency: { limit: 20 } },
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

// Dispatcher: poll rows are provisioned/cleaned up by `syncTriggerPollsForWorkflow`
// (src/lib/workflow-persistence.ts) on every workflow create/edit, so each row
// here corresponds to a live Gmail trigger. Per-poll work lives in
// `handleGmailPoll`.
export const pollGmail = inngest.createFunction(
  { id: "poll-gmail", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const polls = await step.run("fetch-gmail-poll-ids", async () => {
      return prisma.gmailPoll.findMany({ select: { id: true } });
    });

    if (polls.length === 0) return { dispatched: 0 };

    await step.sendEvent(
      "dispatch-gmail-polls",
      polls.map((poll) => ({
        name: "polls/gmail.check",
        data: { pollId: poll.id },
      })),
    );

    return { dispatched: polls.length };
  },
);

// Handler: processes a single Gmail poll (token refresh + unread scan + N
// metadata fetches). Isolated retries + concurrency cap; duplicate runs are
// prevented by the `gmail:<messageId>` idempotency key and the mark-as-read.
export const handleGmailPoll = inngest.createFunction(
  { id: "handle-gmail-poll", retries: 1, concurrency: { limit: 20 } },
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

// Dispatcher: fans out one `polls/google-sheets.check` event per poll row.
// Per-poll work lives in `handleGoogleSheetsPoll`.
export const pollGoogleSheets = inngest.createFunction(
  { id: "poll-google-sheets", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const polls = await step.run("fetch-google-sheets-poll-ids", async () => {
      return prisma.googleSheetsPoll.findMany({ select: { id: true } });
    });

    if (polls.length === 0) return { dispatched: 0 };

    await step.sendEvent(
      "dispatch-google-sheets-polls",
      polls.map((poll) => ({
        name: "polls/google-sheets.check",
        data: { pollId: poll.id },
      })),
    );

    return { dispatched: polls.length };
  },
);

// Handler: processes a single Google Sheets poll. Emits one execution per
// change the poll's `triggerOn` watches: appended rows (row count grew) and/or
// edited rows (a stored per-position content hash changed). Isolated retries +
// concurrency cap; duplicate runs are prevented by the
// `google_sheets:<spreadsheetId>:<rowIndex>[:<hash>]` idempotency key.
export const handleGoogleSheetsPoll = inngest.createFunction(
  { id: "handle-google-sheets-poll", retries: 1, concurrency: { limit: 20 } },
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
        // `headingDataRows` keys by DATA-row index (header excluded), while this
        // poller indexes `rows` from the header at 0. Off by exactly one, and
        // silently wrong if conflated — convert once, here.
        for (const dataRow of headingDataRows(grid.merges).keys()) {
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

// Dispatcher: scans for SchedulePoll rows whose `nextRunAt` is due (indexed on
// `nextRunAt`, so this is O(due) not O(all)) and fans out one
// `polls/schedule.check` event per row. Runs every minute for minute-grained
// schedules. Per-poll work (dispatch + advance) lives in `handleSchedulePoll`.
export const pollSchedules = inngest.createFunction(
  { id: "poll-schedules", retries: 1 },
  { cron: "* * * * *" },
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
  { id: "handle-schedule-poll", retries: 1, concurrency: { limit: 20 } },
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
