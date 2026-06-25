import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authState } = vi.hoisted(() => ({ authState: { userId: "" } }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        authState.userId
          ? { user: { id: authState.userId }, session: { id: "test-session" } }
          : null,
    },
  },
}));

import {
  ExecutionStatus,
  NodeExecutionStatus,
  NodeType,
} from "@/generated/prisma";
import prisma from "@/lib/db";
import { cleanupDb, createCaller, createTestUser } from "@/test/trpc-harness";

const caller = createCaller();

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  authState.userId = user.id;
});

afterEach(async () => {
  await cleanupDb();
});

describe("executions.getStats", () => {
  it("aggregates status counts, success rate, avg duration, daily buckets and top failing nodes", async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Stats workflow", userId: authState.userId },
    });

    const base = Date.now();
    // Two successful runs (4s and 6s) and one failed run.
    await prisma.execution.create({
      data: {
        workflowId: workflow.id,
        inngestEventId: "evt-ok-1",
        status: ExecutionStatus.SUCCESS,
        startedAt: new Date(base - 10_000),
        completedAt: new Date(base - 6_000), // 4s
      },
    });
    await prisma.execution.create({
      data: {
        workflowId: workflow.id,
        inngestEventId: "evt-ok-2",
        status: ExecutionStatus.SUCCESS,
        startedAt: new Date(base - 10_000),
        completedAt: new Date(base - 4_000), // 6s
      },
    });
    const failed = await prisma.execution.create({
      data: {
        workflowId: workflow.id,
        inngestEventId: "evt-fail-1",
        status: ExecutionStatus.FAILED,
        startedAt: new Date(base - 8_000),
        completedAt: new Date(base - 7_000),
      },
    });
    await prisma.nodeExecution.create({
      data: {
        executionId: failed.id,
        nodeId: "n_http",
        nodeType: NodeType.HTTP_REQUEST,
        nodeName: "Call API",
        sequence: 0,
        status: NodeExecutionStatus.FAILED,
        durationMs: 500,
      },
    });

    const stats = await caller.executions.getStats({ days: 30 });

    expect(stats.total).toBe(3);
    expect(stats.success).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.successRate).toBeCloseTo(2 / 3, 5);
    // Avg of the two successful runs: (4 + 6) / 2 = 5s.
    expect(stats.avgDurationSeconds).toBeCloseTo(5, 1);
    expect(stats.runsPerDay.reduce((sum, d) => sum + d.count, 0)).toBe(3);
    expect(stats.topFailingNodes).toEqual([
      { nodeType: NodeType.HTTP_REQUEST, count: 1 },
    ]);
  });

  it("scopes to the calling user and returns empty when there are no runs", async () => {
    // A different user's run must not leak in.
    const other = await createTestUser();
    const otherWorkflow = await prisma.workflow.create({
      data: { name: "Other", userId: other.id },
    });
    await prisma.execution.create({
      data: {
        workflowId: otherWorkflow.id,
        inngestEventId: "evt-other",
        status: ExecutionStatus.SUCCESS,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });

    const stats = await caller.executions.getStats({ days: 30 });

    expect(stats.total).toBe(0);
    expect(stats.successRate).toBeNull();
    expect(stats.avgDurationSeconds).toBeNull();
    expect(stats.runsPerDay).toEqual([]);
    expect(stats.topFailingNodes).toEqual([]);
  });
});
