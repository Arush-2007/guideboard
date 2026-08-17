import {
  planNodeInputSnapshots,
  storeNodeInputSnapshots,
} from "@/features/executions/lib/node-input-snapshot";
import { NodeExecutionStatus, type Prisma } from "@/generated/prisma";
import type { NodeRecorder } from "@/inngest/run-workflow";
import { clampJson } from "@/lib/clamp-json";
import prisma from "@/lib/db";
import { logger } from "@/lib/logger";

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
 * buffer each time and can offer the same record repeatedly. The self-hosted
 * worker reaches the same place by a different road — a reclaimed job resumes
 * `runExecution` from the top and re-runs the engine, whose completed steps are
 * memoized but whose buffer is rebuilt. Three properties make both safe:
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
 *
 * Lives in `src/execution/` rather than `src/inngest/functions.ts`, where it was
 * written, for a reason that is about LOCATION and not about the code: importing
 * it from `functions.ts` executes eight `inngest.createFunction(...)` calls at
 * module load and pulls `@inngest/realtime`'s middleware into the worker process
 * for nothing.
 */
export function createPrismaNodeRecorder({
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

        // `undefined` for a SKIPPED node, because the ENGINE omits `input` on
        // those records — see `NodeRecord.input`. `clampJson(undefined)`
        // returns null, so the column is left unset and the serialization never
        // happens: a branchy workflow records ~37 skipped nodes per run, and
        // walking each one's whole context cost real time inside a step the run
        // waits on.
        //
        // The ROW still gets written. It is what distinguishes "deliberately
        // not run" from "never reached because the run died earlier" — the
        // latter leaves no row at all — and both the skipped panel and replay's
        // refusal message depend on telling those apart.
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
          // Always null now: full snapshots live in `NodeInputSnapshot`, and
          // this column is read-only legacy kept so rows written before that
          // cutover stay replayable. See the schema.
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

      // Oversized contexts: park the full snapshot so replay-from-node can seed
      // real data (a truncation marker would silently corrupt the replay).
      // Only for rows THIS flush inserted, so a rebuilt buffer never re-writes
      // — the objection that sank an earlier design, where `skipDuplicates`
      // deduped at the database long after the bytes had already gone over the
      // wire.
      //
      // One batched insert, and no early return on unconfigured blob storage:
      // this used to require R2, so an unset bucket silently and permanently
      // destroyed the ability to replay any node whose input crossed the 32 KB
      // clamp. Best-effort still — recording must never break a run — but the
      // failure is now a real database error worth logging, not a config gap.
      const snapshots = planNodeInputSnapshots(executionId, prepared);
      if (snapshots.length === 0) return;
      try {
        await storeNodeInputSnapshots(snapshots);
      } catch (err) {
        logger.error("Failed to store full input snapshots", err, {
          executionId,
          nodeIds: snapshots.map((s) => s.nodeId),
        });
      }
    },
  };
}
