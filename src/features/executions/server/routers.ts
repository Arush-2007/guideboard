import z from "zod";
import { PAGINATION } from "@/config/constants";
import { ExecutionStatus, NodeExecutionStatus } from "@/generated/prisma";
import { sendWorkflowExecution } from "@/inngest/utils";
import prisma from "@/lib/db";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

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
  getOne: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => {
      return prisma.execution.findUniqueOrThrow({
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

      await sendWorkflowExecution({
        workflowId: execution.workflowId,
        initialData: (execution.input as Record<string, unknown>) ?? {},
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
        select: { input: true, status: true },
      });

      if (!snapshot) {
        throw new Error("That node has no recorded input to replay from");
      }
      if (snapshot.status === NodeExecutionStatus.SKIPPED) {
        // A skipped node never ran, so there's no meaningful state to replay.
        throw new Error("Can't replay from a node that was skipped");
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
      }),
    )
    .query(async ({ ctx, input }) => {
      const { page, pageSize } = input;

      const [items, totalCount] = await Promise.all([
        prisma.execution.findMany({
          skip: (page - 1) * pageSize,
          take: pageSize,
          where: {
            workflow: {
              userId: ctx.auth.user.id,
            },
          },
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
        prisma.execution.count({
          where: {
            workflow: {
              userId: ctx.auth.user.id,
            },
          },
        }),
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
