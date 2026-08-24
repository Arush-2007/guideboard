import { randomBytes } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { TRPCError } from "@trpc/server";
import z from "zod";
import {
  TOKEN_WEBHOOK_TRIGGER_TYPES,
  TRIGGER_NODE_TYPES,
} from "@/config/node-kinds";
import { NodeType, Prisma } from "@/generated/prisma";
import {
  findDanglingRefsByNode,
  type NodeDanglingRefs,
  stripDanglingRefsInNodes,
} from "@/lib/dangling-refs";
import prisma from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import {
  legacyOutputKey,
  resolveNodeRefs,
  rewriteRefsInJson,
  stripRefFromData,
} from "@/lib/node-ref";
import { computeNextRunAt, isValidSchedule } from "@/lib/schedule";
import type { RowScope } from "@/lib/sheets-trigger-options";
import { SHEETS_TRIGGER_DEFAULT_ROW_SCOPE } from "@/lib/sheets-trigger-options";

/**
 * Shared persistence + validation for AI-generated workflows.
 *
 * Both the manual prompt builder (`workflows.generateFromPrompt`) and the
 * conversational builder (`conversations.chat`) turn an LLM response into the
 * same `{ name, nodes, edges }` shape and persist it identically. This module
 * is the single source of truth for that shape, its integrity checks, the
 * create transaction, and trigger-poll syncing, so a fix in one path can't
 * silently diverge from the other.
 */

export const generatedWorkflowSchema = z.object({
  name: z.string().min(1),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string(),
        position: z.object({ x: z.number(), y: z.number() }),
        data: z.record(z.string(), z.any()).optional(),
      }),
    )
    .min(1)
    .max(8),
  edges: z.array(
    z.object({
      id: z.string().optional(),
      source: z.string().min(1),
      target: z.string().min(1),
    }),
  ),
});

export type GeneratedWorkflow = z.infer<typeof generatedWorkflowSchema>;
export type GeneratedNode = GeneratedWorkflow["nodes"][number];

const NODE_TYPE_VALUES = new Set<string>(Object.values(NodeType));

/**
 * Rejects any edge pointing INTO a trigger.
 *
 * Triggers are workflow roots: the engine runs them unconditionally and never
 * reads an incoming edge (the reachability gate in `src/inngest/run-workflow.ts`
 * roots on node TYPE, not in-degree). An edge into a trigger is therefore
 * meaningless — and worse than inert, because the trigger would fire even on
 * paths that are supposed to be dead: an untaken branch, or once per item inside
 * a fan-out child's replay slice, which the engine explicitly promises won't
 * re-fire triggers.
 *
 * The canvas already refuses to draw one (`invalidConnectionReason` in
 * features/editor/lib/connection-validation.ts) — but that is a *client-side*
 * guard, so every server write path has to enforce it too or a generated (or
 * scripted) graph can persist a shape no user could ever draw. Called by
 * `validateGeneratedWorkflowGraph` (covering both AI builders) and by
 * `workflows.update` (the editor's save). Deliberately the same message as the
 * canvas toast, so the rule reads identically wherever it surfaces.
 */
export function assertNoEdgeIntoTrigger(
  nodes: { id: string; type?: string | null }[],
  edges: { target: string }[],
): void {
  const typeById = new Map(nodes.map((node) => [node.id, node.type ?? null]));
  for (const edge of edges) {
    const type = typeById.get(edge.target);
    if (type && TRIGGER_NODE_TYPES.has(type as NodeType)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Triggers can't receive a connection",
      });
    }
  }
}

/**
 * Validates a generated graph beyond what the Zod schema covers: every node
 * type is a real `NodeType`, node ids are unique, and every edge references
 * known nodes. Throws `TRPCError(BAD_REQUEST)` on the first violation.
 */
export function validateGeneratedWorkflowGraph(
  nodes: GeneratedNode[],
  edges: GeneratedWorkflow["edges"],
): void {
  for (const node of nodes) {
    if (!NODE_TYPE_VALUES.has(node.type)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Invalid node type in generated workflow: ${node.type}`,
      });
    }
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  if (nodeIds.size !== nodes.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Generated workflow has duplicate node ids",
    });
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Generated workflow has an edge referencing unknown node ids",
      });
    }
  }

  // Runs after the endpoint check, so every edge target is known to be a real
  // node before its type is consulted.
  assertNoEdgeIntoTrigger(nodes, edges);
}

/** A generated node ready for `Node.createMany`, bar its `workflowId`. */
type GeneratedNodeRow = {
  id: string;
  name: string;
  type: NodeType;
  ref: string | null;
  position: { x: number; y: number };
  data: Prisma.InputJsonObject;
};

/**
 * Turns a generated graph into node rows: assigns refs, rewrites the references
 * the model wrote, then detects and strips the ones that dangle.
 *
 * Pure, and separate from the transaction, because the ORDER of those three
 * steps is the whole correctness argument and belongs somewhere it can be
 * tested without a database:
 *
 *   1. Assign refs. Shared with `workflows.update` via `resolveNodeRefs` rather
 *      than re-derived — `@@unique([workflowId, ref])` has exactly two write
 *      paths and both go through one door. A generated node carries no
 *      `data.ref` today so every ref is minted, but if the model ever emits one
 *      it is deduped instead of aborting the transaction on a constraint error.
 *   2. Rewrite legacy `<type>_<id>` references to those refs.
 *   3. Only now check for dangling references. Checking BEFORE the rewrite
 *      would condemn the whole graph: a legacy key names something no node
 *      publishes under that name any more. The ref also has to be put back onto
 *      `data` for the check — that is where `readNodeRef` looks when working out
 *      what each node publishes — and stripped again on the way to the column,
 *      which owns it.
 */
export function prepareGeneratedNodes(parsed: GeneratedWorkflow): {
  rows: GeneratedNodeRow[];
  danglingRefs: NodeDanglingRefs[];
} {
  const { refByNodeId } = resolveNodeRefs(parsed.nodes);

  const legacyKeyToRef = new Map<string, string>();
  for (const node of parsed.nodes) {
    const ref = refByNodeId.get(node.id);
    if (ref) legacyKeyToRef.set(legacyOutputKey(node.type, node.id), ref);
  }

  const checkable = parsed.nodes.map((node) => {
    const ref = refByNodeId.get(node.id) ?? null;
    const data = JSON.parse(
      rewriteRefsInJson(
        JSON.stringify(stripRefFromData(node.data)),
        legacyKeyToRef,
      ),
    ) as Record<string, unknown>;
    return {
      id: node.id,
      type: node.type,
      position: node.position,
      // The ref rides in `data` for the check only; the column owns it.
      data: { ...data, ref },
    };
  });

  const danglingRefs = findDanglingRefsByNode(checkable, parsed.edges);
  const cleaned = stripDanglingRefsInNodes(checkable, danglingRefs);

  return {
    danglingRefs,
    rows: cleaned.map((node) => ({
      id: node.id,
      name: node.type,
      type: node.type as NodeType,
      ref: refByNodeId.get(node.id) ?? null,
      position: node.position,
      // Same invariant as `workflows.update`: the ref lives in the column, not
      // the blob, so it can't drift from it. The cast is safe by construction —
      // this blob round-tripped through JSON above.
      data: stripRefFromData(node.data) as Prisma.InputJsonObject,
    })),
  };
}

/**
 * Persists a validated generated workflow (workflow + nodes + connections) in
 * a single transaction, then syncs its trigger poll rows.
 *
 * Returns the new workflow id, plus any DANGLING references the generated graph
 * held — config naming a step that cannot reach it. The AI builder's prompt
 * actively teaches the model `@<REF.path>@`, so it can and does wire a
 * referencing node under the wrong parent; unlike an editor save, nothing human
 * is looking at the canvas here, and a webhook or poll trigger can fire the
 * workflow before anyone opens it.
 *
 * They are STRIPPED rather than kept. A dead token renders to the empty string,
 * so the run would succeed and quietly write blanks; an empty REQUIRED field
 * fails the node's schema at `parseNodeConfig`, so the run stops loudly instead.
 * Callers surface the returned list — see the conversational router, which names
 * the cleared fields in its reply.
 */
export async function persistGeneratedWorkflow(
  userId: string,
  parsed: GeneratedWorkflow,
): Promise<{ workflowId: string; danglingRefs: NodeDanglingRefs[] }> {
  let danglingRefs: NodeDanglingRefs[] = [];

  const { rows, danglingRefs: found } = prepareGeneratedNodes(parsed);
  danglingRefs = found;

  const workflow = await prisma.$transaction(async (tx) => {
    const wf = await tx.workflow.create({
      data: { name: parsed.name, userId },
    });

    await tx.node.createMany({
      data: rows.map((row) => ({ ...row, workflowId: wf.id })),
    });

    if (parsed.edges.length > 0) {
      await tx.connection.createMany({
        data: parsed.edges.map((edge) => ({
          workflowId: wf.id,
          fromNodeId: edge.source,
          toNodeId: edge.target,
          fromOutput: "main",
          toInput: "main",
        })),
      });
    }

    return wf;
  });

  await syncTriggerPollsForWorkflow(userId, workflow.id, parsed.nodes);

  return { workflowId: workflow.id, danglingRefs };
}

/** Node shape needed for poll syncing — works for both generated and edited nodes. */
type SyncableNode = { type?: string | null; data?: unknown };

/**
 * Reconciles the polling-trigger tables (`YoutubeCommentPoll`, `GmailPoll`,
 * `GoogleSheetsPoll`, `SchedulePoll`) with the trigger nodes present in a
 * workflow: upserts a poll row when the matching trigger exists and is
 * configured, and removes stale rows when it doesn't. Called on every create
 * and edit so the cron pollers in `src/inngest/functions.ts` see an accurate
 * set of work.
 */
export async function syncTriggerPollsForWorkflow(
  userId: string,
  workflowId: string,
  nodes: SyncableNode[],
): Promise<void> {
  const youtubeTrigger = nodes.find(
    (n) => n.type === "YOUTUBE_COMMENT_TRIGGER",
  );

  if (youtubeTrigger) {
    const videoId = (youtubeTrigger.data as { videoId?: string } | undefined)
      ?.videoId;

    if (videoId) {
      await prisma.youtubeCommentPoll.upsert({
        where: { workflowId_videoId: { workflowId, videoId } },
        update: {},
        create: {
          userId,
          workflowId,
          videoId,
          lastChecked: new Date(),
        },
      });
    }
  } else {
    await prisma.youtubeCommentPoll.deleteMany({ where: { workflowId } });
  }

  // Gmail triggers carry no per-trigger config (the poller always reads the
  // user's unread inbox), so presence of the node alone provisions the row.
  const gmailTrigger = nodes.find((n) => n.type === "GMAIL_TRIGGER");

  if (gmailTrigger) {
    await prisma.gmailPoll.upsert({
      where: { workflowId },
      update: { userId },
      create: { userId, workflowId },
    });
  } else {
    await prisma.gmailPoll.deleteMany({ where: { workflowId } });
  }

  const googleSheetsTrigger = nodes.find(
    (n) => n.type === "GOOGLE_SHEETS_TRIGGER",
  );

  if (googleSheetsTrigger) {
    const triggerData = (googleSheetsTrigger.data as
      | {
          spreadsheetId?: string;
          sheetName?: string;
          triggerOn?: "added" | "updated" | "added_or_updated";
          rowScope?: RowScope;
          ignoreColumns?: string[];
        }
      | undefined) ?? { spreadsheetId: "", sheetName: "" };

    // Missing on nodes saved before edit-detection existed; those keep the
    // historical append-only behavior.
    const triggerOn = triggerData.triggerOn ?? "added";
    // Missing on nodes saved before headings were understood here; those keep
    // firing on every row, merged section titles included — and keep making one
    // API call per poll. The dialog resolves an absent value through the same
    // constant, so what a user sees is what the poll runs.
    const rowScope = triggerData.rowScope ?? SHEETS_TRIGGER_DEFAULT_ROW_SCOPE;
    // Header names whose edits are ignored; empty watches every column. A change
    // here does NOT need a baseline reset from this side: the poller detects the
    // shifted watched-column projection via `sheetsProjection` and re-seeds
    // itself (see `planSheetsPollChanges`), which also covers header changes made
    // directly in the sheet — the same mechanism in one place.
    const ignoreColumns = triggerData.ignoreColumns ?? [];

    if (triggerData.spreadsheetId && triggerData.sheetName) {
      // Pointing the trigger at a different tab (or a different spreadsheet)
      // invalidates the stored baseline, and nothing downstream can tell.
      // `planSheetsPollChanges` diffs POSITIONALLY against `lastRowCount` +
      // `rowHashes`, so the new tab would be compared with the OLD tab's
      // snapshot: a smaller tab never reaches the old row count and so can never
      // fire at all, and a larger one fires every row past that count as
      // "added" — a burst of runs over rows that were already sitting there.
      //
      // Clearing both makes the next poll a baseline: it records the new tab as
      // it stands and fires nothing, which is precisely what attaching a fresh
      // trigger does. Rows added AFTER that poll fire normally.
      //
      // Only this axis needs handling here. A change to the watched COLUMNS is
      // detected by the poller itself through the stored projection (see
      // `ignoreColumns` above), which also covers headers edited directly in
      // the sheet — one mechanism, one place.
      const existing = await prisma.googleSheetsPoll.findUnique({
        where: { workflowId },
        select: { spreadsheetId: true, sheetName: true },
      });
      const nowWatchingElsewhere =
        existing !== null &&
        (existing.spreadsheetId !== triggerData.spreadsheetId ||
          existing.sheetName !== triggerData.sheetName);

      await prisma.googleSheetsPoll.upsert({
        where: { workflowId },
        update: {
          userId,
          spreadsheetId: triggerData.spreadsheetId,
          sheetName: triggerData.sheetName,
          triggerOn,
          rowScope,
          ignoreColumns,
          // Json column, so a database NULL needs the explicit sentinel.
          ...(nowWatchingElsewhere
            ? { lastRowCount: 0, rowHashes: Prisma.DbNull }
            : {}),
        },
        create: {
          userId,
          workflowId,
          spreadsheetId: triggerData.spreadsheetId,
          sheetName: triggerData.sheetName,
          triggerOn,
          rowScope,
          ignoreColumns,
        },
      });
    }
  } else {
    await prisma.googleSheetsPoll.deleteMany({ where: { workflowId } });
  }

  const scheduleTrigger = nodes.find((n) => n.type === "SCHEDULE_TRIGGER");

  if (scheduleTrigger) {
    const data = scheduleTrigger.data as
      | { cron?: string; timezone?: string }
      | undefined;
    const cron = data?.cron;
    const timezone = data?.timezone;

    if (cron && timezone && isValidSchedule(cron, timezone)) {
      // Only recompute `nextRunAt` when the cron/timezone actually changed, so
      // an unrelated edit to the workflow doesn't shift an already-scheduled
      // firing. A new or retimed schedule gets its next run computed from now.
      const existing = await prisma.schedulePoll.findUnique({
        where: { workflowId },
        select: { cron: true, timezone: true },
      });
      const unchanged =
        existing?.cron === cron && existing?.timezone === timezone;

      if (unchanged) {
        await prisma.schedulePoll.update({
          where: { workflowId },
          data: { userId },
        });
      } else {
        const nextRunAt = computeNextRunAt(cron, timezone);
        await prisma.schedulePoll.upsert({
          where: { workflowId },
          update: { userId, cron, timezone, nextRunAt },
          create: { userId, workflowId, cron, timezone, nextRunAt },
        });
      }
    } else {
      // Trigger present but not validly configured yet — no poll row.
      await prisma.schedulePoll.deleteMany({ where: { workflowId } });
    }
  } else {
    await prisma.schedulePoll.deleteMany({ where: { workflowId } });
  }

  // Token-authenticated webhooks: presence of the node alone provisions a row.
  // The `update` is intentionally a no-op on token/secret so the public URL
  // stays STABLE across edits — rotation only happens via the explicit
  // `webhook.regenerate` mutation. The token is an unguessable cuid; the secret
  // is encrypted at rest.
  //
  // Driven by a list rather than written out per type. When this was a single
  // hardcoded `WEBHOOK_TRIGGER` block, the delete branch matched by workflowId
  // alone — so saving a workflow whose trigger was any OTHER token-authenticated
  // type would delete that type's credentials, had one existed. Scoping by
  // `nodeType` is what lets two such triggers coexist on one workflow without
  // either save erasing the other.
  const presentTypes = TOKEN_WEBHOOK_TRIGGER_TYPES.filter((nodeType) =>
    nodes.some((n) => n.type === nodeType),
  );

  // ONE delete for everything no longer on the canvas, rather than one query per
  // registered type. Same semantics, and it says "remove what is gone" once
  // instead of once per type. It also stops this scaling with the registry: the
  // previous loop issued a round trip per entry on EVERY save of EVERY workflow,
  // so the common case — a workflow with no webhook node at all — paid for the
  // whole list, and each future token webhook would have added a query to saves
  // that have nothing to do with it. Now the cost tracks what is on the canvas.
  await prisma.webhookTrigger.deleteMany({
    where: { workflowId, nodeType: { notIn: presentTypes } },
  });

  for (const nodeType of presentTypes) {
    await prisma.webhookTrigger.upsert({
      where: { workflowId_nodeType: { workflowId, nodeType } },
      // `update` deliberately touches neither the credentials nor
      // `requireSignature`: an existing integration must keep working exactly
      // as its caller was built, and the signing setting is the user's to
      // change from the dialog, not something a workflow save rewrites.
      update: { userId },
      create: {
        userId,
        workflowId,
        nodeType,
        token: createId(),
        secret: encrypt(randomBytes(32).toString("hex")),
        // Secure by default for anything new. Rows that already exist keep the
        // value they were created with, so this cannot break a live webhook —
        // see the field's comment in the schema.
        requireSignature: true,
      },
    });
  }
}
