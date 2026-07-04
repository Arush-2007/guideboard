import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authState, sendWorkflowExecutionMock } = vi.hoisted(() => ({
  authState: { userId: "" },
  sendWorkflowExecutionMock: vi.fn(async () => ({ ids: ["evt"] })),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

// Dispatch is asserted, not performed — stub it (the rest of utils stays real).
vi.mock("@/inngest/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/inngest/utils")>()),
  sendWorkflowExecution: sendWorkflowExecutionMock,
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
  sendWorkflowExecutionMock.mockClear();
});

afterEach(async () => {
  await cleanupDb();
  vi.unstubAllEnvs();
});

const R2_ENV: Record<string, string> = {
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "ak",
  R2_SECRET_ACCESS_KEY: "sk",
  R2_BUCKET: "bucket",
};

const stubR2Configured = () => {
  for (const [k, v] of Object.entries(R2_ENV)) vi.stubEnv(k, v);
};

const stubR2Unconfigured = () => {
  for (const k of Object.keys(R2_ENV)) vi.stubEnv(k, "");
};

/** A truncation marker as clampJson stores it for oversized node inputs. */
const marker = { __truncated: true, bytes: 99_999, preview: "{…" };

const createRunWithNode = async (nodeInput: {
  input: object;
  inputBlobKey?: string | null;
}) => {
  const workflow = await prisma.workflow.create({
    data: { name: "Replay workflow", userId: authState.userId },
  });
  const execution = await prisma.execution.create({
    data: {
      workflowId: workflow.id,
      inngestEventId: `evt-${Math.random()}`,
      status: ExecutionStatus.SUCCESS,
    },
  });
  await prisma.nodeExecution.create({
    data: {
      executionId: execution.id,
      nodeId: "n_target",
      nodeType: NodeType.HTTP_REQUEST,
      nodeName: "Target",
      sequence: 1,
      status: NodeExecutionStatus.SUCCESS,
      input: nodeInput.input,
      inputBlobKey: nodeInput.inputBlobKey ?? null,
    },
  });
  return { workflow, execution };
};

describe("executions.replayFromNode", () => {
  it("seeds the replay inline from a normally-sized recorded input", async () => {
    const { workflow, execution } = await createRunWithNode({
      input: { trigger: { email: "a@b.c" } },
    });

    await caller.executions.replayFromNode({
      executionId: execution.id,
      nodeId: "n_target",
    });

    expect(sendWorkflowExecutionMock).toHaveBeenCalledWith({
      workflowId: workflow.id,
      initialData: { trigger: { email: "a@b.c" } },
      replayFromNodeId: "n_target",
      replayOfExecutionId: execution.id,
    });
  });

  it("dispatches the blob key when the recorded input was truncated", async () => {
    stubR2Configured();
    const { workflow, execution } = await createRunWithNode({
      input: marker,
      inputBlobKey: "replay-contexts/e1/n_target.json",
    });

    await caller.executions.replayFromNode({
      executionId: execution.id,
      nodeId: "n_target",
    });

    expect(sendWorkflowExecutionMock).toHaveBeenCalledWith({
      workflowId: workflow.id,
      initialDataBlobKey: "replay-contexts/e1/n_target.json",
      replayFromNodeId: "n_target",
      replayOfExecutionId: execution.id,
    });
  });

  it("refuses when the input was truncated and no full snapshot exists", async () => {
    const { execution } = await createRunWithNode({ input: marker });

    await expect(
      caller.executions.replayFromNode({
        executionId: execution.id,
        nodeId: "n_target",
      }),
    ).rejects.toThrow(/too large to store inline/);
    expect(sendWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it("refuses when a snapshot exists but R2 is not configured", async () => {
    stubR2Unconfigured();
    const { execution } = await createRunWithNode({
      input: marker,
      inputBlobKey: "replay-contexts/e1/n_target.json",
    });

    await expect(
      caller.executions.replayFromNode({
        executionId: execution.id,
        nodeId: "n_target",
      }),
    ).rejects.toThrow(/R2 is not configured/);
    expect(sendWorkflowExecutionMock).not.toHaveBeenCalled();
  });
});

describe("executions.rerun", () => {
  it("re-dispatches a blob-seeded run by key instead of the stored reference", async () => {
    stubR2Configured();
    const workflow = await prisma.workflow.create({
      data: { name: "Rerun workflow", userId: authState.userId },
    });
    const execution = await prisma.execution.create({
      data: {
        workflowId: workflow.id,
        inngestEventId: "evt-blob-rerun",
        status: ExecutionStatus.SUCCESS,
        input: { __blobRef: "replay-contexts/e1/n1.json" },
      },
    });

    await caller.executions.rerun({ id: execution.id });

    expect(sendWorkflowExecutionMock).toHaveBeenCalledWith({
      workflowId: workflow.id,
      initialDataBlobKey: "replay-contexts/e1/n1.json",
    });
  });

  it("does not honor a __blobRef outside the replay-contexts prefix", async () => {
    // The engine only ever writes replay-contexts/ keys into Execution.input;
    // anything else (e.g. smuggled via a trigger payload) is treated as plain
    // data, so rerun can't be used to hydrate arbitrary bucket objects.
    stubR2Configured();
    const workflow = await prisma.workflow.create({
      data: { name: "Rerun workflow", userId: authState.userId },
    });
    const execution = await prisma.execution.create({
      data: {
        workflowId: workflow.id,
        inngestEventId: "evt-bad-ref",
        status: ExecutionStatus.SUCCESS,
        input: { __blobRef: "conversions/other-user/secret.json" },
      },
    });

    await caller.executions.rerun({ id: execution.id });

    expect(sendWorkflowExecutionMock).toHaveBeenCalledWith({
      workflowId: workflow.id,
      initialData: { __blobRef: "conversions/other-user/secret.json" },
    });
  });
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
