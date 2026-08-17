import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors the other *.integration.test.ts files: the module graph reaches
// `@/lib/auth` -> `@/lib/email` -> `import "server-only"`, which throws under
// vitest. Nothing here exercises auth.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null } },
}));

// The one thing this suite must NOT do is talk to Inngest. Hoisted so the seam
// imports the fake, and a plain array rather than a spy on the real client so
// "was this run sent to Inngest at all" is answerable by inspection.
const sent = vi.hoisted(() => [] as { name: string; data: unknown }[]);
vi.mock("@/inngest/client", () => ({
  inngest: {
    send: async (event: { name: string; data: unknown }) => {
      sent.push(event);
      return { ids: ["evt_fake"] };
    },
  },
}));

import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { fanOutItemIdempotencyKey } from "./fan-out";
import { sendWorkflowExecution } from "./utils";

/**
 * The routing seam against a real Postgres.
 *
 * This is the step where production traffic can first reach the self-hosted
 * worker, and the property under test is not "the code branches correctly" but
 * "**nothing moves unless a row says so**". So every assertion here is made
 * against actual rows: a `WorkflowJob` that exists or does not, and an Inngest
 * event that was or was not sent.
 *
 * Postgres rather than a unit test for three of them specifically — the enum
 * rejection is a database constraint, the default is a column default, and the
 * fan-out pin is resolved by reading an `Execution` row back.
 */

let userId: string;

/** A workflow on the default (unset) runtime, as every existing row is. */
async function newWorkflow(name: string, runtime?: "INNGEST" | "WORKER") {
  const workflow = await prisma.workflow.create({
    data: { name, userId, executionRuntime: runtime },
    select: { id: true },
  });
  return workflow.id;
}

const jobsFor = (workflowId: string) =>
  prisma.workflowJob.findMany({ where: { workflowId } });

beforeEach(async () => {
  await cleanupDb();
  sent.length = 0;
  userId = (await createTestUser()).id;
});

afterAll(async () => {
  await cleanupDb();
  await prisma.$disconnect();
});

describe("sendWorkflowExecution routing", () => {
  it("routes to Inngest by default, and creates no job row", async () => {
    const workflowId = await newWorkflow("default runtime");

    const result = await sendWorkflowExecution({
      workflowId,
      initialData: { hello: "world" },
    });

    expect(result).toEqual({ runtime: "inngest" });
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe("workflows/execute.workflow");
    // The assertion that matters for a migration: the queue is untouched.
    expect(await jobsFor(workflowId)).toHaveLength(0);
  });

  it("routes to the worker when the column says WORKER, without sending", async () => {
    const workflowId = await newWorkflow("worker runtime", "WORKER");

    const result = await sendWorkflowExecution({
      workflowId,
      initialData: { hello: "world" },
    });

    expect(result).toEqual({ runtime: "worker", enqueued: true });
    expect(sent).toHaveLength(0);

    const jobs = await jobsFor(workflowId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("PENDING");
    // The payload the worker will run is the one the caller passed, not a
    // translation of it — `WorkflowExecutionPayload` is one declaration for
    // both runtimes precisely so this is a branch rather than a conversion.
    expect(jobs[0].payload).toMatchObject({ initialData: { hello: "world" } });
  });

  it("routes an explicit INNGEST pin to Inngest", async () => {
    const workflowId = await newWorkflow("pinned", "INNGEST");

    expect(await sendWorkflowExecution({ workflowId })).toEqual({
      runtime: "inngest",
    });
    expect(await jobsFor(workflowId)).toHaveLength(0);
  });

  it("reports a duplicate rather than enqueuing twice", async () => {
    const workflowId = await newWorkflow("dedup", "WORKER");

    const first = await sendWorkflowExecution({
      workflowId,
      idempotencyKey: "gmail:abc",
    });
    const second = await sendWorkflowExecution({
      workflowId,
      idempotencyKey: "gmail:abc",
    });

    expect(first).toEqual({ runtime: "worker", enqueued: true });
    expect(second).toEqual({ runtime: "worker", enqueued: false });
    expect(await jobsFor(workflowId)).toHaveLength(1);
  });

  it("falls back to Inngest for a workflow that no longer exists", async () => {
    // §9.17: a workflow deleted between trigger and dispatch. Preserving
    // today's behaviour (send, and let the function fail to load it) rather
    // than inventing a new failure mode at the seam.
    await sendWorkflowExecution({ workflowId: "deleted-workflow-id" });
    expect(sent).toHaveLength(1);
  });
});

describe("Workflow.executionRuntime is an enum", () => {
  /**
   * The entire point of making the column an enum. As free text a typo fell
   * back to Inngest silently, which is indistinguishable from the routing
   * switch not being deployed — on the one column that decides which runtime
   * executes a client's workflow, set by hand during the migration.
   */
  it("rejects a typo instead of silently falling back to Inngest", async () => {
    const workflowId = await newWorkflow("typo target");

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Workflow" SET "executionRuntime" = 'woker' WHERE id = $1`,
        workflowId,
      ),
    ).rejects.toThrow();

    // And the row is untouched, so the failed write cannot half-apply.
    const after = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflowId },
      select: { executionRuntime: true },
    });
    expect(after.executionRuntime).toBeNull();
  });

  it("accepts the two real values", async () => {
    const workflowId = await newWorkflow("valid target");

    for (const value of ["WORKER", "INNGEST"] as const) {
      await prisma.workflow.update({
        where: { id: workflowId },
        data: { executionRuntime: value },
      });
      const after = await prisma.workflow.findUniqueOrThrow({
        where: { id: workflowId },
        select: { executionRuntime: true },
      });
      expect(after.executionRuntime).toBe(value);
    }
  });
});

describe("a fan-out chain never splits across runtimes", () => {
  /**
   * Why this matters more than lineage: the two runtimes enforce "one run of a
   * workflow at a time" through mechanisms that cannot see each other — a
   * partial unique index here, Inngest's `concurrency` key there. That
   * interlock is what keeps a chain ORDERED, because item 5 cannot start while
   * item 4 is running. A chain split across both loses it, and two items run at
   * once.
   */
  async function parentExecution(
    workflowId: string,
    runtime: "worker" | "inngest",
  ) {
    const execution = await prisma.execution.create({
      data: {
        workflowId,
        status: "RUNNING",
        // Exactly what each runtime writes: the worker has no Inngest event and
        // stamps a synthetic `job_<jobId>` (src/worker/run-job.ts), which is
        // what makes the runtime readable back off the row.
        inngestEventId:
          runtime === "worker"
            ? `job_${crypto.randomUUID()}`
            : crypto.randomUUID(),
      },
      select: { id: true },
    });
    return execution.id;
  }

  const chainFor = (executionId: string, index: number) => ({
    nodeId: "fanout-node",
    outputKey: "FAN_OUT_1",
    index,
    total: 3,
    executionId,
    onItemFailure: "continue" as const,
  });

  it("stamps item 0 from the parent run, not from the column", async () => {
    const workflowId = await newWorkflow("chain start", "WORKER");
    // The parent ran on INNGEST, and the column has since been flipped to
    // WORKER — the exact mid-flight change the pin exists for. Item 0 is
    // dispatched from INSIDE the still-running parent, so following the column
    // here would run it concurrently with its own parent.
    const executionId = await parentExecution(workflowId, "inngest");

    const result = await sendWorkflowExecution({
      workflowId,
      idempotencyKey: fanOutItemIdempotencyKey(executionId, "fanout-node", 0),
      fanOutChain: chainFor(executionId, 0),
    });

    expect(result).toEqual({ runtime: "inngest" });
    expect(await jobsFor(workflowId)).toHaveLength(0);
    // …and the pin is written into the link, so no later item pays for another
    // lookup or risks a different answer.
    expect(
      (sent[0].data as { fanOutChain: { runtime: string } }).fanOutChain
        .runtime,
    ).toBe("inngest");
  });

  it("keeps later links on the chain's runtime after the column flips", async () => {
    const workflowId = await newWorkflow("chain middle", "WORKER");
    const executionId = await parentExecution(workflowId, "inngest");

    // Link 2 of a chain already pinned to Inngest, while the column says
    // WORKER. The pin must win, and must do so without reading the parent.
    const result = await sendWorkflowExecution({
      workflowId,
      idempotencyKey: fanOutItemIdempotencyKey(executionId, "fanout-node", 2),
      fanOutChain: { ...chainFor(executionId, 2), runtime: "inngest" },
    });

    expect(result).toEqual({ runtime: "inngest" });
    expect(await jobsFor(workflowId)).toHaveLength(0);
  });

  it("pins in the other direction too: a worker chain stays on the worker", async () => {
    // The symmetric case, and the one a rollback produces: the column is set
    // back to Inngest while a worker-started chain is mid-flight. Splitting
    // here is the same bug, so the chain drains on the worker.
    const workflowId = await newWorkflow("chain rollback", undefined);
    const executionId = await parentExecution(workflowId, "worker");

    const result = await sendWorkflowExecution({
      workflowId,
      idempotencyKey: fanOutItemIdempotencyKey(executionId, "fanout-node", 1),
      fanOutChain: chainFor(executionId, 1),
    });

    expect(result).toEqual({ runtime: "worker", enqueued: true });
    expect(sent).toHaveLength(0);

    const jobs = await jobsFor(workflowId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      fanOutChain: { runtime: "worker", index: 1 },
    });
  });

  it("falls through to the column when a chain has no pin and no parent row", async () => {
    // Chains already in flight across the deploy that added the field carry no
    // `runtime`. They predate any routing, so Inngest is the correct reading —
    // and this is the only path where the parent lookup can miss.
    const workflowId = await newWorkflow("legacy chain", "WORKER");

    const result = await sendWorkflowExecution({
      workflowId,
      fanOutChain: chainFor("execution-that-was-deleted", 1),
    });

    // No parent row, so the column is the only remaining signal and is used.
    expect(result).toEqual({ runtime: "worker", enqueued: true });
  });
});
