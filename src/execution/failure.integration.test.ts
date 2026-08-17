import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors the other *.integration.test.ts files: the module graph reaches
// `@/lib/auth` -> `@/lib/email` -> `import "server-only"`, which throws under
// vitest. Nothing here exercises auth.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null } },
}));

// The chain advance sends a real Inngest event. Captured, so an assertion is
// about what the failure DECIDED to dispatch rather than about Inngest being
// reachable — and so a "stop" policy asserting nothing was sent is meaningful.
const { sentExecutions, sendShouldThrow } = vi.hoisted(() => ({
  sentExecutions: [] as Array<Record<string, unknown>>,
  sendShouldThrow: { value: false },
}));
vi.mock("@/inngest/utils", () => ({
  sendWorkflowExecution: vi.fn(async (input: Record<string, unknown>) => {
    if (sendShouldThrow.value) throw new Error("Inngest is unreachable");
    sentExecutions.push(input);
    return { ids: ["evt_fake"] };
  }),
}));

const { sentEmails } = vi.hoisted(() => ({
  sentEmails: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (msg: Record<string, unknown>) => {
    sentEmails.push(msg);
  }),
}));

import {
  ExecutionStatus,
  NodeExecutionStatus,
  NodeType,
} from "@/generated/prisma";
import type { FanOutChain } from "@/inngest/fan-out";
import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { settleFailedExecution } from "./failure";

/**
 * `settleFailedExecution` is the whole of Inngest's `onFailure` as a plain
 * function, and it is where a fan-out chain's failed half is handed on. The
 * ordering it encodes is the record of a real incident: a failed CHILD is the
 * only thing still holding the chain, so under the default "continue" policy
 * skipping the advance silently drops every remaining item.
 *
 * Against real Postgres because both branches are database writes whose
 * INTERACTION is the point — the row must end up FAILED whether or not the
 * advance succeeded.
 */

let userId: string;
let workflowId: string;

const chain = (overrides: Partial<FanOutChain> = {}): FanOutChain => ({
  nodeId: "node_fanout",
  outputKey: "item",
  index: 2,
  total: 10,
  executionId: "exec_parent",
  onItemFailure: "continue",
  ...overrides,
});

async function newExecution(inngestEventId: string) {
  return prisma.execution.create({
    data: { workflowId, inngestEventId },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanupDb();
  sentExecutions.length = 0;
  sentEmails.length = 0;
  sendShouldThrow.value = false;

  // `createTestUser` already sets an email, which is all the alert path needs.
  userId = (await createTestUser()).id;
  workflowId = (
    await prisma.workflow.create({
      data: { name: "Failing workflow", userId },
      select: { id: true },
    })
  ).id;
});

describe("settleFailedExecution — the fan-out chain", () => {
  it("advances the chain under the default 'continue' policy", async () => {
    // The load-bearing case. Without this, one bad item ends the fan-out and
    // the remaining 7 never run, with nothing anywhere saying why.
    const execution = await newExecution("evt_continue");

    await settleFailedExecution({
      locate: { id: execution.id },
      error: new Error("item 2 blew up"),
      workflowId,
      fanOutChain: chain(),
    });

    expect(sentExecutions).toHaveLength(1);
    expect(sentExecutions[0]).toMatchObject({
      workflowId,
      replayFromNodeId: "node_fanout",
      // Lineage points at the ORIGINAL parent, not at this failed sibling.
      replayOfExecutionId: "exec_parent",
      fanOutChain: expect.objectContaining({ index: 3 }),
    });

    const row = await prisma.execution.findUniqueOrThrow({
      where: { id: execution.id },
    });
    expect(row.status).toBe(ExecutionStatus.FAILED);
    // Nothing was stranded, so no note is appended.
    expect(row.error).not.toMatch(/were not started/);
  });

  it("stops the chain and names the abandoned items under 'stop'", async () => {
    const execution = await newExecution("evt_stop");

    const { error } = await settleFailedExecution({
      locate: { id: execution.id },
      error: new Error("item 2 blew up"),
      workflowId,
      fanOutChain: chain({ onItemFailure: "stop" }),
    });

    expect(sentExecutions).toEqual([]);
    // total 10, index 2 -> 7 items after this one never start. They leave no
    // rows of their own, so this run is the ONLY place that can report it.
    expect(error).toContain("The remaining 7 items of this fan-out");
    expect(error).toContain("set to stop the run when an item fails");

    const row = await prisma.execution.findUniqueOrThrow({
      where: { id: execution.id },
    });
    expect(row.error).toContain("The remaining 7 items");
  });

  it("still records FAILED, with a different note, when the advance throws", async () => {
    // Best-effort is the whole point: a dispatch failure must never stop the run
    // from being recorded. The chain dies here — nothing else holds it — so the
    // user gets the same truncation note under a different cause.
    const execution = await newExecution("evt_send_fails");
    sendShouldThrow.value = true;

    const { error } = await settleFailedExecution({
      locate: { id: execution.id },
      error: new Error("item 2 blew up"),
      workflowId,
      fanOutChain: chain(),
    });

    expect(error).toContain("The remaining 7 items of this fan-out");
    expect(error).toContain("could not hand the chain on");

    const row = await prisma.execution.findUniqueOrThrow({
      where: { id: execution.id },
    });
    expect(row.status).toBe(ExecutionStatus.FAILED);
  });

  it("does not advance a run that carries no chain", async () => {
    const execution = await newExecution("evt_no_chain");

    await settleFailedExecution({
      locate: { id: execution.id },
      error: new Error("ordinary failure"),
      workflowId,
    });

    expect(sentExecutions).toEqual([]);
  });
});

describe("settleFailedExecution — the recorded cause", () => {
  it("prepends the cause-unknown diagnosis when no node recorded", async () => {
    // Zero NodeExecution rows means the run never reached the engine's own
    // failure path — usually the platform ending the run.
    const execution = await newExecution("evt_no_nodes");

    const { error } = await settleFailedExecution({
      locate: { id: execution.id },
      error: new Error("function timed out"),
      workflowId,
    });

    expect(error).toContain("cause unknown");
    expect(error).toContain("function timed out");
  });

  it("keeps the raw message once a node has recorded", async () => {
    const execution = await newExecution("evt_with_nodes");
    await prisma.nodeExecution.create({
      data: {
        executionId: execution.id,
        nodeId: "node_a",
        nodeType: NodeType.HTTP_REQUEST,
        nodeName: "Call the API",
        sequence: 0,
        status: NodeExecutionStatus.FAILED,
        durationMs: 12,
        completedAt: new Date(),
        error: "500 from upstream",
      },
    });

    const { error } = await settleFailedExecution({
      locate: { id: execution.id },
      error: new Error("500 from upstream"),
      workflowId,
    });

    expect(error).toBe("500 from upstream");
    // The email names the offending node.
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].subject).toContain("Call the API");
  });

  it("reads a message off Inngest's JSON-round-tripped error", async () => {
    // ⚠️ `onFailure` receives an error that has been through JSON, so it is a
    // plain object and fails `instanceof Error`. Reaching for `String(err)`
    // would have put "[object Object]" in the user's failure email.
    const execution = await newExecution("evt_serialized");

    const { error } = await settleFailedExecution({
      locate: { id: execution.id },
      error: {
        name: "Error",
        message: "the serialized message",
        stack: "Error: the serialized message\n    at somewhere",
      },
      workflowId,
    });

    expect(error).toContain("the serialized message");
    expect(error).not.toContain("[object Object]");

    const row = await prisma.execution.findUniqueOrThrow({
      where: { id: execution.id },
    });
    expect(row.errorStack).toContain("at somewhere");
  });
});

describe("settleFailedExecution — the locator", () => {
  it("finds the same row by execution id and by inngest event id", async () => {
    // The two runtimes name the run differently and must reach the same row:
    // the worker holds the id on its job row, Inngest's `onFailure` has only
    // the event.
    const execution = await newExecution("evt_locator");

    const byEvent = await settleFailedExecution({
      locate: { inngestEventId: "evt_locator" },
      error: new Error("boom"),
      workflowId,
    });
    expect(byEvent.executionId).toBe(execution.id);

    const byId = await settleFailedExecution({
      locate: { id: execution.id },
      error: new Error("boom again"),
      workflowId,
    });
    expect(byId.executionId).toBe(execution.id);
  });
});

describe("settleFailedExecution — the failure email", () => {
  it("honours the per-user opt-out", async () => {
    const execution = await newExecution("evt_opt_out");
    await prisma.notificationSettings.create({
      data: { userId, notifyOnFailure: false },
    });

    await settleFailedExecution({
      locate: { id: execution.id },
      error: new Error("boom"),
      workflowId,
    });

    expect(sentEmails).toEqual([]);
  });

  it("records FAILED even when the email throws", async () => {
    const execution = await newExecution("evt_email_throws");
    const { sendEmail } = await import("@/lib/email");
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("Resend is down"));

    await settleFailedExecution({
      locate: { id: execution.id },
      error: new Error("boom"),
      workflowId,
    });

    const row = await prisma.execution.findUniqueOrThrow({
      where: { id: execution.id },
    });
    expect(row.status).toBe(ExecutionStatus.FAILED);
  });
});
