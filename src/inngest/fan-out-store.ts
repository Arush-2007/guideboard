import { NonRetriableError } from "inngest";
import type { WorkflowContext } from "@/features/executions/types";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/db";
import type { FanOutChain, FanOutSource } from "./fan-out";

/**
 * Persistence half of fan-out: the shared payload a chain's children read.
 * Split from `fan-out.ts` (which stays pure, so the planning is unit testable
 * with no database) and from `functions.ts` (so these two queries — the only
 * place the storage shape is known — can be exercised directly against a real
 * Postgres in `fan-out-store.integration.test.ts`).
 *
 * The pairing is the point: `storeFanOutSource` writes the payload ONCE for a
 * whole chain and `readFanOutSource` pulls back exactly one item, which is what
 * lets a chain link on the wire be a fixed-size cursor. See the header of
 * `fan-out.ts` for why the previous carry-it-on-the-event design was O(N^2).
 */

/**
 * Stores a fan-out's shared context and its items, keyed by
 * `(executionId, nodeId)` so two fan-out nodes in one run stay separate.
 *
 * `upsert` + `skipDuplicates` rather than `create`: this runs inside the
 * dispatcher's `step.run`, which Inngest re-runs whole on retry. A plain create
 * would hit the unique constraint and fail identically on every attempt,
 * turning a transient DB blip into a permanently dead fan-out.
 */
export async function storeFanOutSource({
  executionId,
  nodeId,
  source,
}: {
  executionId: string;
  nodeId: string;
  source: FanOutSource;
}): Promise<void> {
  await prisma.fanOutSource.upsert({
    where: { executionId_nodeId: { executionId, nodeId } },
    create: {
      executionId,
      nodeId,
      context: source.context as Prisma.InputJsonObject,
      items: {
        createMany: {
          skipDuplicates: true,
          data: source.items.map((item, index) => ({
            index,
            // `FanOutItem.item` is a REQUIRED Json column, for which Prisma
            // rejects both a bare `null` (read as SQL NULL, which the column
            // forbids) and `undefined` (read as "omit this field", which leaves
            // a required column unset). A hole in an items array is legitimate
            // input — and the payload this replaced carried one fine as ordinary
            // JSON — so neither may become a write failure that kills the whole
            // fan-out with an opaque Prisma error, where every other unstorable
            // payload gets an actionable NonRetriableError.
            //
            // Both collapse to the JSON value `null`, which reads back as
            // `null`. `undefined` cannot round-trip through JSON anyway: it is
            // exactly what the inline payload would have become on the wire.
            item: (item === null || item === undefined
              ? Prisma.JsonNull
              : item) as Prisma.InputJsonValue,
          })),
        },
      },
    },
    update: {},
    select: { id: true },
  });
}

/**
 * Resolves the one `(context, item)` pair a chain link needs.
 *
 * The nested `where` on `items` is what makes this O(1) in the item count: the
 * child reads its own row through the `(sourceId, index)` primary key and never
 * transfers, let alone parses, the other N-1 items. Fetching the list and
 * indexing in JS would reintroduce the quadratic cost this design removed —
 * just against the database instead of the event budget.
 *
 * A missing row is a data problem no retry resolves (both the write and this
 * read sit inside checkpointed steps, so the only routes here are a pruned
 * execution or a hand-deleted row), hence NonRetriableError.
 */
export async function readFanOutSource(
  chain: FanOutChain,
): Promise<{ context: WorkflowContext; item: unknown }> {
  const source = await prisma.fanOutSource.findUnique({
    where: {
      executionId_nodeId: {
        executionId: chain.executionId,
        nodeId: chain.nodeId,
      },
    },
    select: {
      context: true,
      items: { where: { index: chain.index }, select: { item: true } },
    },
  });

  if (!source) {
    throw new NonRetriableError(
      `The item list for this fan-out (node ${chain.nodeId} of execution ` +
        `${chain.executionId}) no longer exists, so item ${chain.index + 1} ` +
        `of ${chain.total} cannot run. Re-run the workflow.`,
    );
  }

  const row = source.items[0];
  if (!row) {
    throw new NonRetriableError(
      `Item ${chain.index + 1} of ${chain.total} is missing from this ` +
        `fan-out's stored item list (node ${chain.nodeId}).`,
    );
  }

  return {
    context: (source.context ?? {}) as WorkflowContext,
    item: row.item,
  };
}
