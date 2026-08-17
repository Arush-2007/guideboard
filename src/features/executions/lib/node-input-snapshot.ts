import type { Prisma } from "@/generated/prisma";
import { type ClampedMarker, isClampedMarker } from "@/lib/clamp-json";
import prisma from "@/lib/db";

/**
 * Full, unclamped node input snapshots — the data `replayFromNode` seeds a
 * replay with when `NodeExecution.input` had to be reduced to a truncation
 * marker.
 *
 * Both sides live here because they are one contract with two distant callers:
 * the engine's recorder writes (src/execution/node-recorder.ts) and the executions
 * router reads (../server/routers.ts). Splitting them meant the size policy and
 * the storage shape were stated twice.
 *
 * ## Why Postgres, replacing R2
 *
 * Snapshots used to go to blob storage, which is OPTIONAL in this codebase —
 * every other consumer degrades when it is unset (avatar upload is a feature
 * flag, signed-URL refresh no-ops, the convert node refuses a single action).
 * The recorder instead returned early, so an oversized input left no snapshot
 * at all and replay-from-node became permanently impossible for that node —
 * silent, irreversible, and invisible until someone tried to replay weeks
 * later. Measured on a dev database: 94 such rows, the largest a mere 53.6 KB.
 *
 * Losing recoverable data to an unset environment variable is the flaw, not the
 * size. The database is a hard dependency, so it is the honest home.
 */

/**
 * Ceiling on one stored snapshot.
 *
 * Above it, `NodeExecution.input` keeps its truncation marker and replay
 * refuses with the message it already has — the same outcome as before, now
 * reached only by genuinely enormous contexts rather than by a missing bucket.
 * 4 MB is ~75x the largest snapshot observed in practice and ~120x the 32 KB
 * clamp that sends a payload here in the first place, so it bounds a runaway
 * context without being reachable by a real workflow.
 */
export const NODE_INPUT_SNAPSHOT_MAX_BYTES = 4_194_304;

/**
 * Whether a clamped input is worth storing in full.
 *
 * Takes the MARKER, not the value: `clampJson` already measured the payload to
 * decide it was oversized, and parks the result in `marker.bytes`. Reading that
 * back costs nothing, where re-serializing to check the size would walk a large
 * context a second time on the run's critical path.
 *
 * `bytes: -1` is `clampJson`'s unserializable case (cycles, BigInt). It cannot
 * be written as JSON here either, so it is not storable at any size.
 */
export function isSnapshotStorable(marker: ClampedMarker): boolean {
  return marker.bytes > 0 && marker.bytes <= NODE_INPUT_SNAPSHOT_MAX_BYTES;
}

/**
 * Stores full input snapshots for one flush of node records.
 *
 * `createMany` + `skipDuplicates` in a single round trip: the recorder's flush
 * is re-entrant (Inngest re-executes the handler body at every step boundary,
 * so the same records can be offered again), and a snapshot is written once and
 * never revised. Duplicates are therefore not merely tolerable but expected,
 * and the database is the right place to drop them.
 */
export async function storeNodeInputSnapshots(
  rows: { executionId: string; nodeId: string; input: unknown }[],
): Promise<void> {
  if (rows.length === 0) return;
  await prisma.nodeInputSnapshot.createMany({
    skipDuplicates: true,
    data: rows.map((r) => ({
      executionId: r.executionId,
      nodeId: r.nodeId,
      input: r.input as Prisma.InputJsonValue,
    })),
  });
}

/**
 * Whether a full snapshot exists, without transferring it.
 *
 * The replay path only needs to know which branch to take — it dispatches a
 * REFERENCE, since the payload is by definition past the 32 KB clamp and can
 * reach `NODE_INPUT_SNAPSHOT_MAX_BYTES`. Reading the row just to test it for
 * null would pull up to 4 MB into a tRPC handler that then discards it.
 */
export async function hasNodeInputSnapshot(
  executionId: string,
  nodeId: string,
): Promise<boolean> {
  const row = await prisma.nodeInputSnapshot.findUnique({
    where: { executionId_nodeId: { executionId, nodeId } },
    select: { executionId: true },
  });
  return row !== null;
}

/**
 * The full input recorded for a node, or `null` when none was stored (the input
 * fit inline, exceeded the cap, or predates this table).
 */
export async function readNodeInputSnapshot(
  executionId: string,
  nodeId: string,
): Promise<unknown | null> {
  const row = await prisma.nodeInputSnapshot.findUnique({
    where: { executionId_nodeId: { executionId, nodeId } },
    select: { input: true },
  });
  return row?.input ?? null;
}

/**
 * Picks the snapshot rows a flush should write, given each record's already
 * computed clamp result. Pure, so the policy — which statuses qualify, which
 * sizes fit — is testable without a database.
 *
 * SKIPPED nodes are excluded because `replayFromNode` refuses them outright: a
 * node that never ran has no state worth replaying, so storing its context
 * would be dead weight no reader can reach.
 */
export function planNodeInputSnapshots<
  T extends { nodeId: string; input?: unknown },
>(
  executionId: string,
  prepared: { record: T; clampedInput: unknown }[],
): { executionId: string; nodeId: string; input: unknown }[] {
  const rows: { executionId: string; nodeId: string; input: unknown }[] = [];
  for (const { record, clampedInput } of prepared) {
    // No explicit SKIPPED check: a skipped record carries no `input` at all
    // (see `NodeRecord.input`), so it clamps to nothing and cannot be a marker.
    // Testing the status here too would state the same policy in a second
    // place, where the two could drift.
    if (!isClampedMarker(clampedInput)) continue;
    if (!isSnapshotStorable(clampedInput)) continue;
    rows.push({ executionId, nodeId: record.nodeId, input: record.input });
  }
  return rows;
}
