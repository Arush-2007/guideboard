import type { Realtime } from "@inngest/realtime";
import { NonRetriableError } from "inngest";
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

// The fan-out dispatcher and the chain advance send real Inngest events.
vi.mock("@/inngest/utils", () => ({
  sendWorkflowExecution: vi.fn(async () => ({ ids: ["evt_fake"] })),
}));

// THE assertion for "no premature email". `settleFailedExecution` is the only
// thing that sends one, so counting sends counts settles.
const { sentEmails } = vi.hoisted(() => ({
  sentEmails: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (msg: Record<string, unknown>) => {
    sentEmails.push(msg);
  }),
}));

// One controllable executor per node type. The engine, the recorder, the step
// store, `runExecution`, the queue and the heartbeat are all REAL — only the
// leaf work is faked, so every property under test is proven through the same
// code production runs.
const { executors } = vi.hoisted(() => ({
  executors: new Map<string, (params: FakeExecutorParams) => unknown>(),
}));
vi.mock("@/features/executions/lib/executor-registry", () => ({
  getExecutor: (type: string) => {
    const fake = executors.get(type);
    if (!fake) throw new Error(`No fake executor registered for ${type}`);
    return fake;
  },
}));

import type {
  ExecutorStep,
  WorkflowContext,
} from "@/features/executions/types";
import {
  ExecutionStatus,
  NodeType,
  type WorkflowJob,
} from "@/generated/prisma";
import prisma from "@/lib/db";
import {
  claimNextJob,
  enqueueWorkflowJob,
  reclaimExpiredJobs,
} from "@/queue/jobs";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { controlPlaneDb } from "./db";
import { runJob, settleRunFailure } from "./run-job";

/**
 * The worker running a real job against a real Postgres.
 *
 * `run-execution.integration.test.ts` proves the ENGINE resumes without
 * repeating a completed step. This file proves the layer above it: that a
 * worker holds its job while it runs, **stops the instant it stops holding
 * it**, and reports every ending to the queue in the one order that does not
 * lie to the user.
 *
 * The headline is the fencing test. It is the single highest-risk behaviour in
 * the self-hosted runtime — without it, a reclaimed lease means two processes
 * executing one run, both appending rows to a client's spreadsheet.
 *
 * ⚠️ The triage tests exist because three of the four wrong orderings are
 * plausible and silent: settling before `failJob` emails the owner once per
 * attempt, settling a fenced run marks failed a run another worker is finishing
 * successfully, and settling a run whose row does not exist throws out of the
 * worker loop.
 */

type FakeExecutorParams = {
  data: Record<string, unknown>;
  nodeId: string;
  outputKey: string;
  executionId: string;
  userId: string;
  context: WorkflowContext;
  step: ExecutorStep;
  publish: Realtime.PublishFn;
};

/**
 * A one-second lease, so a fence lands inside a test — real in every other
 * respect.
 *
 * The LEASE is the seam, not the beat interval, so `runJob` derives a 250 ms
 * heartbeat from it exactly as it derives 15 s from the shipping 60 s. The
 * 1:4 ratio under test is therefore the one that ships.
 */
const SHORT_LEASE_SECONDS = 1;
const SHORT_BEAT_MS = (SHORT_LEASE_SECONDS * 1000) / 4;

const WORKER = "worker-under-test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Another worker takes the lease, by the only route that can: a real UPDATE. */
const steal = (jobId: string) =>
  prisma.$executeRaw`UPDATE "WorkflowJob" SET "lockedBy" = 'thief' WHERE id = ${jobId}`;

let userId: string;
let workflowId: string;

beforeEach(async () => {
  await cleanupDb();
  sentEmails.length = 0;
  executors.clear();
  userId = (await createTestUser()).id;

  executors.set(
    NodeType.MANUAL_TRIGGER,
    ({ context, outputKey }: FakeExecutorParams) => ({
      ...context,
      [outputKey]: { fired: true },
    }),
  );

  ({ workflowId } = await buildWorkflow());
});

afterAll(async () => {
  await cleanupDb();
  // The worker's control-plane pool is a SECOND client, constructed at import.
  // Left connected it keeps the vitest worker alive after the last assertion.
  await controlPlaneDb.$disconnect();
});

/**
 * A trigger -> action workflow. The action is `GOOGLE_SHEETS_ACTION` because
 * that type is checkpointed by the engine, which is what gives its executor the
 * REAL worker step rather than the inline shim — and the worker step is where
 * the fence is enforced.
 */
async function buildWorkflow() {
  const workflow = await prisma.workflow.create({
    data: { name: "worker job", userId },
    select: { id: true },
  });

  await prisma.node.createMany({
    data: [
      {
        id: `trig_${workflow.id}`,
        workflowId: workflow.id,
        type: NodeType.MANUAL_TRIGGER,
        name: "Manual trigger",
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: `act_${workflow.id}`,
        workflowId: workflow.id,
        type: NodeType.GOOGLE_SHEETS_ACTION,
        name: "Append the row",
        position: { x: 250, y: 0 },
        data: {},
      },
    ],
  });
  await prisma.connection.create({
    data: {
      workflowId: workflow.id,
      fromNodeId: `trig_${workflow.id}`,
      toNodeId: `act_${workflow.id}`,
    },
  });

  return { workflowId: workflow.id, actionNodeId: `act_${workflow.id}` };
}

/** Enqueue and claim, exactly as the claim loop does. */
async function claimOne(
  payload: Record<string, unknown> = {},
  maxAttempts = 3,
): Promise<WorkflowJob> {
  await enqueueWorkflowJob({ workflowId, payload, maxAttempts });
  const job = await claimNextJob({ workerId: WORKER });
  if (!job) throw new Error("nothing to claim");
  return job;
}

const readJob = (id: string) =>
  prisma.workflowJob.findUniqueOrThrow({ where: { id } });

const readRun = (executionId: string) =>
  prisma.execution.findUniqueOrThrow({ where: { id: executionId } });

// ---------------------------------------------------------------------------

describe("runJob — the happy path", () => {
  it("claims, runs, completes, and leaves both rows agreeing", async () => {
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, async (params) => {
      const { step, context, outputKey } = params;
      const plan = (await step.run("plan", async () => ({ row: 7 }))) as {
        row: number;
      };
      await step.run("write", async () => ({ wrote: plan.row }));
      return { ...context, [outputKey]: { row: plan.row } };
    });

    const job = await claimOne();
    const result = await runJob({ job, workerId: WORKER });

    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") return;

    const run = await readRun(result.executionId);
    expect(run.status).toBe(ExecutionStatus.SUCCESS);
    // The synthetic id is what makes a resumed attempt adopt this row rather
    // than create a second, and it is the correlation back to the queue.
    expect(run.inngestEventId).toBe(`job_${job.id}`);

    const nodes = await prisma.nodeExecution.findMany({
      where: { executionId: result.executionId },
      orderBy: { sequence: "asc" },
    });
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.status === "SUCCESS")).toBe(true);

    const row = await readJob(job.id);
    expect(row.status).toBe("SUCCEEDED");
    expect(row.executionId).toBe(result.executionId);
    expect(row.lockedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.lastError).toBeNull();
  });

  it("records the execution id at CREATION, not at completion", async () => {
    // The improvement the worker claims over Inngest's `onFailure`, which
    // addresses rows by `inngestEventId` and cannot report a pre-row failure.
    // It is only real if the id is on the job row before anything failable runs.
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, () => {
      throw new Error("failed after the row existed");
    });

    const job = await claimOne({}, 3);
    await runJob({ job, workerId: WORKER });

    const row = await readJob(job.id);
    expect(row.executionId).not.toBeNull();
    // …and it names the run that actually happened.
    const run = await readRun(row.executionId as string);
    expect(run.inngestEventId).toBe(`job_${job.id}`);
  });

  it("completes a duplicate rather than failing it", async () => {
    // A duplicate did its work by correctly doing nothing. Failing it would
    // burn attempts and email the owner about a run that was never wrong.
    await prisma.execution.create({
      data: {
        workflowId,
        inngestEventId: "evt_original",
        idempotencyKey: "gmail:msg-1",
      },
    });
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, () => {
      throw new Error("the engine must not run for a duplicate");
    });

    const job = await claimOne({ idempotencyKey: "gmail:msg-1" });
    const result = await runJob({ job, workerId: WORKER });

    expect(result.outcome).toBe("duplicate");
    expect((await readJob(job.id)).status).toBe("SUCCEEDED");
    expect(sentEmails).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("runJob — fencing", () => {
  it("aborts at the next step boundary when its lease is stolen, and performs no further side effect", async () => {
    // ⚠️ THE test. Without this behaviour, a reclaimed lease means two
    // processes executing one run — both appending rows to a client's
    // spreadsheet, which is the one failure the whole design forbids.
    //
    // The lease is stolen by a genuine competing UPDATE mid-run, and the fence
    // is discovered by the REAL heartbeat (merely sped up), so this exercises
    // heartbeatJob -> diagnoseLostLease -> FencedError -> abort signal ->
    // assertNotFenced end to end.
    const sideEffects: string[] = [];

    // Claimed first, because the executor below needs the job id to steal from.
    const job = await claimOne();

    executors.set(NodeType.GOOGLE_SHEETS_ACTION, async (params) => {
      const { step, context, outputKey } = params;

      await step.run("before", async () => {
        sideEffects.push("before");
        return { ok: true };
      });

      await steal(job.id);
      // Several beats, so the fence is discovered by a real renewal failing
      // rather than by the test's timing being lucky.
      await sleep(SHORT_BEAT_MS * 3);

      await step.run("after", async () => {
        sideEffects.push("after");
        return { ok: true };
      });

      return { ...context, [outputKey]: { done: true } };
    });

    const result = await runJob({
      job,
      workerId: WORKER,
      leaseSeconds: SHORT_LEASE_SECONDS,
    });

    // 1. It stopped, and it knows why.
    expect(result).toEqual({ outcome: "fenced", reason: "lease-stolen" });

    // 2. THE assertion: the second side effect never happened.
    expect(sideEffects).toEqual(["before"]);

    // 3. The run is NOT marked FAILED. The thief owns this run's outcome now,
    //    and may be finishing it successfully at this very moment.
    const run = await prisma.execution.findUniqueOrThrow({
      where: { inngestEventId: `job_${job.id}` },
    });
    expect(run.status).toBe(ExecutionStatus.RUNNING);
    expect(run.error).toBeNull();

    // 4. Nothing was written to the job row either — no spent attempt, no
    //    recorded error, and the thief still holds it.
    const row = await readJob(job.id);
    expect(row.status).toBe("RUNNING");
    expect(row.lockedBy).toBe("thief");
    expect(row.lastError).toBeNull();

    // 5. And the owner was not told their run failed, because it did not.
    expect(sentEmails).toEqual([]);
  });

  it("stops before any node runs when the job was lost before the attach", async () => {
    // The window between claiming and creating the execution row. Catching it
    // here is what stops a fenced worker executing an entire workflow it does
    // not own.
    const ran: string[] = [];
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, (params) => {
      ran.push("action");
      return params.context;
    });

    const job = await claimOne();
    await steal(job.id);

    const result = await runJob({ job, workerId: WORKER });

    expect(result).toEqual({ outcome: "fenced", reason: "lease-stolen" });
    expect(ran).toEqual([]);
    expect(sentEmails).toEqual([]);
  });

  it("names a deleted job row rather than reporting a stolen lease", async () => {
    // Deleting a workflow mid-run cascades the job row away. Aborting is right;
    // calling it a lease theft would send an operator after a host problem that
    // does not exist.
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, (params) => params.context);

    const job = await claimOne();
    await prisma.workflowJob.delete({ where: { id: job.id } });

    const result = await runJob({ job, workerId: WORKER });
    expect(result).toEqual({ outcome: "fenced", reason: "job-row-gone" });
  });

  it("reports the reaper taking a job back as its own reason", async () => {
    // `not-running`: still ours by `lockedBy`, no longer RUNNING. This is also
    // the shape a cancellation will take, which is why it is not folded into
    // `lease-stolen`.
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, (params) => params.context);

    const job = await claimOne();
    // ⚠️ `lockedBy: null` alongside the status, because that is what a reclaim
    // actually writes — the reaper, `failJob` and `completeJob` all clear the
    // two together. Leaving `lockedBy` set would pin a row state nothing in the
    // codebase produces, and would pass even against a diagnosis that reports
    // every reclaim as `lease-stolen`.
    await prisma.workflowJob.update({
      where: { id: job.id },
      data: { status: "PENDING", lockedBy: null },
    });

    const result = await runJob({ job, workerId: WORKER });
    expect(result).toEqual({ outcome: "fenced", reason: "not-running" });
  });

  it("self-fences when the heartbeat HANGS rather than fails", async () => {
    // ⚠️ The partition this fence was invented for, and the one an error-based
    // test cannot reach. Against a blackholed TCP connection — packets dropped
    // with no RST — the renewal never settles and never throws. A staleness
    // check that lived in the `catch` would therefore never run, and worse, the
    // re-entrancy guard would latch on forever after the first hung beat: the
    // worker would keep executing for hours on a job the reaper had already
    // handed to somebody else. Two processes, one run.
    const sideEffects: string[] = [];
    const job = await claimOne();

    // Real for everything except the renewal, which never resolves. Matched on
    // the one statement only the heartbeat issues, so the attach and the
    // terminal write still work — the run has to get far enough to fence.
    const hangingHeartbeat = {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join("?").includes('SET "leaseExpiresAt"')) {
          return new Promise(() => {});
        }
        return (
          prisma as unknown as {
            $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => unknown;
          }
        ).$queryRaw(strings, ...values);
      },
    } as unknown as Parameters<typeof runJob>[0]["client"];

    executors.set(NodeType.GOOGLE_SHEETS_ACTION, async (params) => {
      const { step, context, outputKey } = params;

      await step.run("before", async () => {
        sideEffects.push("before");
        return { ok: true };
      });

      // Past `fenceAfterMs` (a lease minus one beat) with every renewal still
      // hanging, so the fence can only come from the staleness check.
      await sleep(SHORT_LEASE_SECONDS * 1000 + SHORT_BEAT_MS);

      await step.run("after", async () => {
        sideEffects.push("after");
        return { ok: true };
      });

      return { ...context, [outputKey]: { done: true } };
    });

    const result = await runJob({
      job,
      workerId: WORKER,
      client: hangingHeartbeat,
      leaseSeconds: SHORT_LEASE_SECONDS,
    });

    expect(result).toEqual({ outcome: "fenced", reason: "lease-expired" });
    // THE assertion: it stopped before the second side effect.
    expect(sideEffects).toEqual(["before"]);
    expect(sentEmails).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("runJob — the failure triage", () => {
  it("schedules a retry and leaves the run RUNNING, with NO email", async () => {
    // ⚠️ The ordering bug this exists to catch: settling on every attempt marks
    // the row FAILED mid-retry, advances the fan-out chain early, and emails
    // the owner once per attempt for ONE run. Inngest's `onFailure` fires once,
    // after the last retry.
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, () => {
      throw new Error("a transient blip");
    });

    const job = await claimOne({}, 3);
    const result = await runJob({ job, workerId: WORKER });

    expect(result.outcome).toBe("retry-scheduled");

    const row = await readJob(job.id);
    expect(row.status).toBe("PENDING");
    expect(row.attempt).toBe(1);
    expect(row.lastError).toContain("a transient blip");
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());

    // The run is not over, so its row must not say it is.
    const run = await readRun(row.executionId as string);
    expect(run.status).toBe(ExecutionStatus.RUNNING);
    expect(run.completedAt).toBeNull();

    // THE assertion.
    expect(sentEmails).toEqual([]);
  });

  it("settles the run FAILED exactly once, on the last attempt", async () => {
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, () => {
      throw new Error("still broken");
    });

    // Two attempts: the first retries, the second exhausts.
    const first = await claimOne({}, 2);
    expect((await runJob({ job: first, workerId: WORKER })).outcome).toBe(
      "retry-scheduled",
    );
    expect(sentEmails).toHaveLength(0);

    // Backdated rather than set to `new Date()`: the claim compares against
    // Postgres' `now()`, and this container's clock need not be behind this
    // process's for the retry to be due.
    await prisma.workflowJob.update({
      where: { id: first.id },
      data: { runAt: new Date(Date.now() - 60_000) },
    });
    const second = await claimNextJob({ workerId: WORKER });
    if (!second) throw new Error("the retry was not claimable");

    const result = await runJob({ job: second, workerId: WORKER });
    expect(result.outcome).toBe("failed");

    const row = await readJob(second.id);
    expect(row.status).toBe("FAILED");

    const run = await readRun(row.executionId as string);
    expect(run.status).toBe(ExecutionStatus.FAILED);
    expect(run.error).toContain("still broken");
    expect(run.completedAt).not.toBeNull();

    // Once for the whole run, not once per attempt.
    expect(sentEmails).toHaveLength(1);
  });

  it("spends every attempt on a NonRetriableError and settles immediately", async () => {
    // A config error is not going to fix itself, and `failJob` — not this file
    // — is what knows that. Handing it the raw error is the point.
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, () => {
      throw new NonRetriableError("that spreadsheet does not exist");
    });

    const job = await claimOne({}, 4);
    const result = await runJob({ job, workerId: WORKER });

    expect(result.outcome).toBe("failed");
    const row = await readJob(job.id);
    expect(row.status).toBe("FAILED");
    expect(row.attempt).toBe(row.maxAttempts);
    expect((await readRun(row.executionId as string)).status).toBe(
      ExecutionStatus.FAILED,
    );
    expect(sentEmails).toHaveLength(1);
  });

  it("records a failure that happened BEFORE the execution row existed", async () => {
    // `settleFailedExecution` throws on a missing row, deliberately. So a
    // pre-row failure has to land on the job row instead of throwing out of the
    // worker loop — which is more than Inngest manages at all: it addresses
    // rows by `inngestEventId`, so a failure before the row exists is invisible.
    //
    // ⚠️ Getting BEFORE the row is the hard part, and it is worth stating why
    // the obvious setups do not: a cyclic workflow throws in `prepare-workflow`,
    // which is item 4 — the row already exists by then — and deleting the
    // workflow cascades the job row away, so there is nothing left to record
    // onto. What remains is the real scenario: the workflow this job names is
    // gone, so `create-execution`'s insert fails its foreign key. The job row
    // itself is untouched and still ours, which is exactly the state a worker
    // finds after a workflow is deleted mid-queue.
    const claimed = await claimOne({}, 1);
    const job = { ...claimed, workflowId: "wf_deleted_before_the_run" };

    const result = await runJob({ job, workerId: WORKER });

    // Did not throw, and reported honestly that there is no run to point at.
    expect(result).toEqual({ outcome: "failed", executionId: null });

    const row = await readJob(job.id);
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toBeTruthy();
    expect(row.executionId).toBeNull();
    // Nothing to email about — there is no run.
    expect(sentEmails).toEqual([]);
  });

  it("abandons quietly when the job was taken between the throw and the report", async () => {
    // `not-owned`. Writing anything from here would be writing about a run that
    // now belongs to somebody else.
    const job = await claimOne();

    executors.set(NodeType.GOOGLE_SHEETS_ACTION, async () => {
      // The lease goes at the same moment the run fails, so the throw and the
      // loss are genuinely concurrent rather than ordered by the test.
      await steal(job.id);
      throw new Error("failed into a lost lease");
    });

    const result = await runJob({ job, workerId: WORKER });

    expect(result).toEqual({ outcome: "abandoned" });
    const row = await readJob(job.id);
    // Untouched by us: the thief's to finish or fail.
    expect(row.status).toBe("RUNNING");
    expect(row.lastError).toBeNull();
    expect(sentEmails).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the reaper's exhausted jobs", () => {
  it("settles the run of a job that died without ever reporting", async () => {
    // ⚠️ The poison-job hole. `reclaimExpiredJobs` marks the JOB failed, which
    // says nothing to the `Execution` row — so without the settle the user's
    // run reads RUNNING forever, they get no email, and a fan-out chain it held
    // drops every remaining item. Nothing else can report these runs: the
    // process that was executing them is gone.
    const run = await prisma.execution.create({
      data: { workflowId, inngestEventId: "job_poison" },
      select: { id: true },
    });
    const job = await prisma.workflowJob.create({
      data: {
        workflowId,
        payload: {},
        status: "RUNNING",
        lockedBy: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 60_000),
        attempt: 3,
        maxAttempts: 3,
        reclaims: 2, // past the free refunds
        executionId: run.id,
      },
    });

    const { exhausted } = await reclaimExpiredJobs();
    expect(exhausted).toHaveLength(1);

    // What the reaper tick in `main.ts` does with them.
    for (const dead of exhausted) {
      await settleRunFailure({
        executionId: dead.executionId,
        error: new Error("the worker stopped responding"),
        workflowId: dead.workflowId,
        payload: dead.payload,
        jobId: dead.id,
      });
    }

    expect((await readJob(job.id)).status).toBe("FAILED");
    const settled = await readRun(run.id);
    expect(settled.status).toBe(ExecutionStatus.FAILED);
    expect(settled.completedAt).not.toBeNull();
    expect(sentEmails).toHaveLength(1);
  });

  it("does not throw when the dead job never created a run", async () => {
    // A job killed before `attachExecutionToJob` has no row to settle, and the
    // reaper must not die on it — it is in the middle of a batch.
    await prisma.workflowJob.create({
      data: {
        workflowId,
        payload: {},
        status: "RUNNING",
        lockedBy: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 60_000),
        attempt: 2,
        maxAttempts: 2,
        reclaims: 2,
      },
    });

    const { exhausted } = await reclaimExpiredJobs();
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].executionId).toBeNull();

    await expect(
      settleRunFailure({
        executionId: exhausted[0].executionId,
        error: new Error("gone"),
        workflowId: exhausted[0].workflowId,
        payload: exhausted[0].payload,
        jobId: exhausted[0].id,
      }),
    ).resolves.toBeUndefined();
    expect(sentEmails).toEqual([]);
  });
});
