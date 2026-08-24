import { NonRetriableError } from "inngest";
import { settleFailedExecution } from "@/execution/failure";
import type { WorkflowExecutionPayload } from "@/execution/payload";
import { EXECUTION_RETENTION_DAYS } from "@/execution/retention";
import { runExecution } from "@/execution/run-execution";
import { NodeType, type Prisma } from "@/generated/prisma";
import { deleteBlobsByPrefix, isBlobConfigured } from "@/lib/blob";
import prisma from "@/lib/db";
import {
  getSheetGrid,
  mergedDataRows,
  SHEETS_READ,
  sheetRange,
} from "@/lib/google-sheets";
import { refreshGoogleTokenIfNeeded } from "@/lib/google-token";
import { HTTP_TIMEOUT, http, rethrowTimeout } from "@/lib/http";
import { logger } from "@/lib/logger";
import type { RowScope } from "@/lib/sheets-trigger-options";
import { SHEETS_TRIGGER_DEFAULT_ROW_SCOPE } from "@/lib/sheets-trigger-options";
import { fetchNewYoutubeComments } from "@/lib/youtube-comments";
import { pruneWorkflowJobs } from "@/queue/jobs";
import { inngest } from "./client";
import type { FanOutChain } from "./fan-out";
import { POLL_CRON } from "./poll-cron";
import { resolveWorkflowRetries } from "./retry-policy";
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
import { sendWorkflowExecution } from "./utils";

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
    // The whole of this handler is `settleFailedExecution`. It stays a thin
    // wrapper because `onFailure` is a SEPARATE callback that never sees the
    // handler's scope — all it has is the event, so `inngestEventId` is the
    // only way it can name the run. The worker names the row directly; see
    // `ExecutionLocator`.
    onFailure: async ({ event }) => {
      const inngestEventId = event.data.event.id;
      const { workflowId, fanOutChain } = event.data.event.data as {
        workflowId?: string;
        fanOutChain?: FanOutChain;
      };

      // Mirrors the handler's own guard. Unreachable in practice —
      // `sendWorkflowExecution` always mints an id — but without one there is
      // no way to name the row, and the `update` this replaces would have died
      // inside Prisma with an opaque "needs at least one argument" instead of
      // saying so.
      if (!inngestEventId) {
        logger.error(
          "A workflow execution failed with no event id to record it against",
          event.data.error,
          { workflowId },
        );
        return;
      }

      await settleFailedExecution({
        locate: { inngestEventId },
        error: event.data.error,
        workflowId,
        fanOutChain,
      });
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
    const { workflowId, ...payload } = event.data as {
      workflowId?: string;
    } & WorkflowExecutionPayload;

    if (!inngestEventId || !workflowId) {
      throw new NonRetriableError("Event ID or workflow ID is missing");
    }

    // Both step parameters are the SAME object here, and that is the whole
    // difference between the runtimes: Inngest's step exists before the run
    // does, so items 1-4 can be checkpointed exactly as they always were. The
    // worker's cannot — its store is keyed on the execution id these very items
    // produce — so it passes a pass-through for the first and a real memoizing
    // step for the second. See `runExecution`.
    const result = await runExecution({
      workflowId,
      inngestEventId,
      payload,
      runStep: step,
      engineStepFor: () => step,
      publish,
    });

    if (result.skipped) {
      return {
        skipped: true,
        reason: result.reason,
        existingExecutionId: result.existingExecutionId,
      };
    }

    return {
      workflowId,
      result: result.context,
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
// dispatchers cost three times one combined empty tick, for byte-identical
// behaviour. The absolute numbers move with `POLL_CRON` (three dispatchers at
// a 15-minute interval is ~8.6k billed steps a month against ~2.9k), but the
// 3x ratio this decision rests on does not. The three
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
  { cron: POLL_CRON },
  async ({ step }) => {
    const { events, failed } = await step.run("fetch-poll-ids", async () => {
      // `allSettled`, not `all`: sharing one step means one rejection would
      // otherwise take the other two providers' dispatch down with it, which is
      // the isolation the three separate functions used to give for free. A
      // provider that fails is skipped for this tick alone and recovers on the
      // next one a poll interval later — cheaper than losing all three. Retrying
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
              sheetName: poll.sheetName,
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
            sheetName: poll.sheetName,
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
// `polls/schedule.check` event per row. Per-poll work (dispatch + advance)
// lives in `handleSchedulePoll`.
export const pollSchedules = inngest.createFunction(
  { id: "poll-schedules", retries: 1 },
  { cron: POLL_CRON },
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
    const cutoff = new Date(
      Date.now() - EXECUTION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    // Queue rows first, and deliberately BEFORE the early return below: job
    // retention must not be conditional on there being old executions to prune
    // the same day. A quiet week for executions is not a quiet week for the
    // queue, and skipping this is how the table that deduplicates idempotency
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

    // Row deletion (below) is what enforces retention; blob GC is best-effort
    // so an R2 hiccup never blocks pruning. Blobs are deleted first — their
    // lifetime must not exceed the rows that reference them, and a failed
    // prefix is retried implicitly if row deletion also fails this run.
    if (prunable.length > 0 && isBlobConfigured()) {
      await step.run("delete-execution-blobs", async () => {
        let deleted = 0;
        for (const execution of prunable) {
          const prefixes = [
            // LEGACY, and self-draining: nothing writes `replay-contexts/`
            // any more (full node inputs go to `NodeInputSnapshot`, fan-out
            // item lists to `FanOutSource`). Kept until every run predating
            // that cutover has aged past the 30-day cutoff — after which this
            // prefix, `inputBlobKey`, and its read path all go together.
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

    const result =
      prunable.length === 0
        ? { count: 0 }
        : await step.run("delete-old-executions", async () => {
            return prisma.execution.deleteMany({
              where: { id: { in: prunable.map((e) => e.id) } },
            });
          });

    // Queue rows LAST, and that ordering is load-bearing rather than tidy.
    //
    // This function is `retries: 0`. Running the job prune first meant a single
    // failure in it — a lock wait, a pool timeout on a large DELETE — aborted
    // the whole run before any execution was pruned, with no retry. A persistent
    // condition would then stop execution retention indefinitely while the
    // dashboard showed one failed cron a day. Last, it can only ever cost
    // itself. (An earlier comment here claimed the step was "retried
    // independently"; `retries: 0` means nothing in this function is.)
    //
    // Deliberately NOT behind an early return on `prunable.length`: a quiet week
    // for executions is not a quiet week for the queue, and skipping this is how
    // the table that deduplicates idempotency keys grows unbounded.
    //
    // ⚠️ **INTERIM HOME.** `WorkflowJob` is the worker's table — the worker
    // claims from it, heartbeats it, and already reaps expired leases from it
    // on its own timer (`reapOnce`, src/worker/main.ts), which is the slot this
    // belongs in. It sits here only because execution retention already did,
    // and that is fine for all of Part 1 (Inngest stays deployed and serving
    // throughout). **Move it to the worker's reaper loop when Inngest is
    // deleted** — otherwise a fully worker-routed install still needs the
    // Inngest scheduler alive purely to bound this table, which is exactly the
    // dependency the migration exists to remove.
    const jobs = await step.run("prune-workflow-jobs", () =>
      pruneWorkflowJobs(),
    );

    return {
      deletedCount: result.count,
      prunedJobs: jobs.deleted,
      cutoff: cutoff.toISOString(),
    };
  },
);
