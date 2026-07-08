import z from "zod";
import { PAGINATION } from "@/config/constants";
import { ExecutionStatus, NodeExecutionStatus } from "@/generated/prisma";
import { sendWorkflowExecution } from "@/inngest/utils";
import { isBlobConfigured } from "@/lib/blob";
import { isClampedMarker } from "@/lib/clamp-json";
import prisma from "@/lib/db";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";
import { refreshBlobUrls } from "./refresh-blob-urls";

// The on-canvas failure popover shows an error at a glance, not the full stack.
// Cap the returned message so the payload stays small; the untrimmed text is
// always available on the execution detail page ("View execution").
const MAX_NODE_FAILURE_ERROR_LENGTH = 600;

/**
 * Execution rows seeded from a blob-stored snapshot persist `{ __blobRef }`
 * instead of the oversized payload (see executeWorkflow's create-execution).
 * Only `replay-contexts/` keys are honored — that's the only prefix the engine
 * ever writes here, so a `__blobRef` smuggled into a trigger payload can't
 * make rerun hydrate an arbitrary bucket object.
 */
function asBlobRef(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).__blobRef === "string"
  ) {
    const key = (value as { __blobRef: string }).__blobRef;
    return key.startsWith("replay-contexts/") ? key : null;
  }
  return null;
}

export const executionsRouter = createTRPCRouter({
  getRecentFailures: protectedProcedure.query(async ({ ctx }) => {
    return prisma.execution.findMany({
      where: {
        workflow: { userId: ctx.auth.user.id },
        status: ExecutionStatus.FAILED,
      },
      orderBy: { startedAt: "desc" },
      take: 5,
      select: {
        id: true,
        startedAt: true,
        error: true,
        workflow: { select: { id: true, name: true } },
      },
    });
  }),
  // On-demand failure detail for one canvas node: the latest FAILED run of that
  // node, owner-scoped through execution -> workflow. Powers the red-node popover
  // in the editor so a failure shows its real error + a link to the run without
  // leaving the canvas. `nodeId` is a globally-unique Node cuid, so it alone
  // identifies the node; the query is served by NodeExecution[nodeId]. Returns
  // null when the node has no recorded failure (e.g. it has since succeeded).
  getLatestNodeFailure: protectedProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(async ({ ctx, input }) => {
      const failure = await prisma.nodeExecution.findFirst({
        where: {
          nodeId: input.nodeId,
          status: NodeExecutionStatus.FAILED,
          execution: { workflow: { userId: ctx.auth.user.id } },
        },
        orderBy: { completedAt: "desc" },
        // Only what the canvas popover renders: the error text + the run to link
        // to. Full detail (stack, node name, timing) lives on the detail page.
        select: {
          executionId: true,
          error: true,
        },
      });

      if (!failure) return null;

      return {
        executionId: failure.executionId,
        error: failure.error
          ? failure.error.slice(0, MAX_NODE_FAILURE_ERROR_LENGTH)
          : null,
      };
    }),
  getOne: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const execution = await prisma.execution.findUniqueOrThrow({
        where: {
          id: input.id,
          workflow: {
            userId: ctx.auth.user.id,
          },
        },
        include: {
          workflow: {
            select: {
              id: true,
              name: true,
              // Node configs power the Friendly *input* view: we read each node's
              // `@<…>@` references to show only the upstream fields it actually
              // uses (not the whole accumulated context).
              nodes: {
                select: { id: true, data: true },
              },
            },
          },
          nodeExecutions: {
            orderBy: { sequence: "asc" },
          },
        },
      });

      // Stored signed blob URLs expire after an hour; re-sign them at read
      // time so old executions keep working file links (no-op with a public
      // base URL or without R2).
      return {
        ...execution,
        output: await refreshBlobUrls(execution.output),
        nodeExecutions: await Promise.all(
          execution.nodeExecutions.map(async (ne) => ({
            ...ne,
            input: await refreshBlobUrls(ne.input),
            output: await refreshBlobUrls(ne.output),
          })),
        ),
      };
    }),
  rerun: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Ownership-checked load; reuses the persisted trigger payload so the new
      // run is identical to the original. No idempotency key -> always fresh.
      const execution = await prisma.execution.findUniqueOrThrow({
        where: {
          id: input.id,
          workflow: { userId: ctx.auth.user.id },
        },
        select: { workflowId: true, input: true },
      });

      // A blob-seeded run stored `{ __blobRef }`; re-dispatch by key so the
      // full snapshot (too big for the event payload) is hydrated in-function.
      const blobRef = asBlobRef(execution.input);
      if (blobRef && !isBlobConfigured()) {
        throw new Error(
          "This run's input lives in blob storage, but R2 is not configured. " +
            "Set the R2_* environment variables to re-run it.",
        );
      }

      await sendWorkflowExecution({
        workflowId: execution.workflowId,
        ...(blobRef
          ? { initialDataBlobKey: blobRef }
          : {
              initialData: (execution.input as Record<string, unknown>) ?? {},
            }),
      });

      return { success: true };
    }),
  // Replay an execution starting at a chosen node: re-run that node and its
  // descendants only, reusing the exact context that flowed into it the first
  // time (its recorded `NodeExecution.input`). Lets a user fix one node's config
  // and replay forward without re-running expensive upstream nodes. No
  // idempotency key -> always a fresh run (a replay must never dedupe against
  // the original), and `replayOfExecutionId` links it back for lineage.
  replayFromNode: protectedProcedure
    .input(z.object({ executionId: z.string(), nodeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Ownership-checked load of the origin run.
      const execution = await prisma.execution.findUniqueOrThrow({
        where: {
          id: input.executionId,
          workflow: { userId: ctx.auth.user.id },
        },
        select: { workflowId: true },
      });

      // The snapshot of context that entered the chosen node. Take the first
      // recorded run of that node (by sequence) — deterministic, and the one a
      // user means when there's only a single run per node today.
      const snapshot = await prisma.nodeExecution.findFirst({
        where: { executionId: input.executionId, nodeId: input.nodeId },
        orderBy: { sequence: "asc" },
        select: { input: true, inputBlobKey: true, status: true },
      });

      if (!snapshot) {
        throw new Error("That node has no recorded input to replay from");
      }
      if (snapshot.status === NodeExecutionStatus.SKIPPED) {
        // A skipped node never ran, so there's no meaningful state to replay.
        throw new Error("Can't replay from a node that was skipped");
      }

      // An oversized input was stored as a truncation marker; replaying from
      // the marker would silently feed the run garbage (every upstream
      // reference resolves empty). Use the full R2 snapshot when one exists,
      // refuse clearly when it doesn't.
      if (isClampedMarker(snapshot.input)) {
        if (!snapshot.inputBlobKey) {
          throw new Error(
            "This node's input was too large to store inline and no full " +
              "snapshot exists (the run predates full snapshots or blob " +
              "storage was off when it ran), so replaying it would use " +
              "incomplete data. Re-run the whole workflow instead.",
          );
        }
        if (!isBlobConfigured()) {
          throw new Error(
            "This node's full input lives in blob storage, but R2 is not " +
              "configured. Set the R2_* environment variables to replay it.",
          );
        }
        await sendWorkflowExecution({
          workflowId: execution.workflowId,
          initialDataBlobKey: snapshot.inputBlobKey,
          replayFromNodeId: input.nodeId,
          replayOfExecutionId: input.executionId,
        });
        return { success: true };
      }

      await sendWorkflowExecution({
        workflowId: execution.workflowId,
        initialData: (snapshot.input as Record<string, unknown>) ?? {},
        replayFromNodeId: input.nodeId,
        replayOfExecutionId: input.executionId,
      });

      return { success: true };
    }),
  getNotificationSettings: protectedProcedure.query(async ({ ctx }) => {
    const settings = await prisma.notificationSettings.findUnique({
      where: { userId: ctx.auth.user.id },
      select: { notifyOnFailure: true },
    });
    // Default on when the user has never touched the setting.
    return { notifyOnFailure: settings?.notifyOnFailure ?? true };
  }),
  updateNotificationSettings: protectedProcedure
    .input(z.object({ notifyOnFailure: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return prisma.notificationSettings.upsert({
        where: { userId: ctx.auth.user.id },
        create: {
          userId: ctx.auth.user.id,
          notifyOnFailure: input.notifyOnFailure,
        },
        update: { notifyOnFailure: input.notifyOnFailure },
        select: { notifyOnFailure: true },
      });
    }),
  // Lightweight analytics over the user's runs in the last `days`. Every query
  // is scoped by `workflow.userId` and hits existing indexes
  // (Execution[workflowId,status,startedAt], NodeExecution[executionId,sequence]);
  // the two raw queries are parameterized date-bucket/avg aggregations.
  getStats: protectedProcedure
    .input(z.object({ days: z.number().min(1).max(365).default(30) }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.auth.user.id;
      const cutoff = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
      const scope = {
        workflow: { userId },
        startedAt: { gte: cutoff },
      };

      const [byStatus, durationRows, dailyRows, topFailingNodes] =
        await Promise.all([
          prisma.execution.groupBy({
            by: ["status"],
            where: scope,
            _count: { _all: true },
          }),
          prisma.$queryRaw<Array<{ avg_seconds: number | null }>>`
            SELECT AVG(EXTRACT(EPOCH FROM (e."completedAt" - e."startedAt")))::float AS avg_seconds
            FROM "Execution" e
            JOIN "Workflow" w ON w."id" = e."workflowId"
            WHERE w."userId" = ${userId}
              AND e."startedAt" >= ${cutoff}
              AND e."completedAt" IS NOT NULL
              AND e."status"::text = 'SUCCESS'
          `,
          prisma.$queryRaw<Array<{ day: Date; count: number }>>`
            SELECT date_trunc('day', e."startedAt") AS day, COUNT(*)::int AS count
            FROM "Execution" e
            JOIN "Workflow" w ON w."id" = e."workflowId"
            WHERE w."userId" = ${userId} AND e."startedAt" >= ${cutoff}
            GROUP BY day
            ORDER BY day ASC
          `,
          prisma.nodeExecution.groupBy({
            by: ["nodeType"],
            where: {
              status: NodeExecutionStatus.FAILED,
              execution: scope,
            },
            _count: { _all: true },
            orderBy: { _count: { nodeType: "desc" } },
            take: 5,
          }),
        ]);

      const countFor = (status: ExecutionStatus) =>
        byStatus.find((row) => row.status === status)?._count._all ?? 0;

      const success = countFor(ExecutionStatus.SUCCESS);
      const failed = countFor(ExecutionStatus.FAILED);
      const running = countFor(ExecutionStatus.RUNNING);
      const total = success + failed + running;
      const completed = success + failed;

      return {
        days: input.days,
        total,
        success,
        failed,
        running,
        // Over completed runs only; null when there's nothing to rate yet.
        successRate: completed > 0 ? success / completed : null,
        avgDurationSeconds: durationRows[0]?.avg_seconds ?? null,
        runsPerDay: dailyRows.map((row) => ({
          day: row.day.toISOString(),
          count: Number(row.count),
        })),
        topFailingNodes: topFailingNodes.map((row) => ({
          nodeType: row.nodeType,
          count: row._count._all,
        })),
      };
    }),
  getMany: protectedProcedure
    .input(
      z.object({
        page: z.number().default(PAGINATION.DEFAULT_PAGE),
        pageSize: z
          .number()
          .min(PAGINATION.MIN_PAGE_SIZE)
          .max(PAGINATION.MAX_PAGE_SIZE)
          .default(PAGINATION.DEFAULT_PAGE_SIZE),
        status: z.nativeEnum(ExecutionStatus).nullish(),
        workflowId: z.string().nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { page, pageSize, status, workflowId } = input;

      // Owner scope always applies; status/workflow narrow it when set. The same
      // `where` feeds findMany and count so totalCount (and thus pagination)
      // stays consistent with the active filters.
      const where = {
        workflow: { userId: ctx.auth.user.id },
        ...(status ? { status } : {}),
        ...(workflowId ? { workflowId } : {}),
      };

      const [items, totalCount] = await Promise.all([
        prisma.execution.findMany({
          skip: (page - 1) * pageSize,
          take: pageSize,
          where,
          orderBy: {
            startedAt: "desc",
          },
          include: {
            workflow: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        }),
        prisma.execution.count({ where }),
      ]);

      const totalPages = Math.ceil(totalCount / pageSize);
      const hasNextPage = page < totalPages;
      const hasPreviousPage = page > 1;

      return {
        items,
        page,
        pageSize,
        totalCount,
        totalPages,
        hasNextPage,
        hasPreviousPage,
      };
    }),
});
