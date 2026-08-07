import { NonRetriableError, RetryAfterError } from "inngest";
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

import {
  FAILED_JOB_RETENTION_DAYS,
  SUCCEEDED_JOB_RETENTION_DAYS,
} from "@/execution/retention";
import type { Prisma } from "@/generated/prisma";
import { resolveWorkflowRetries } from "@/inngest/retry-policy";
import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import {
  attachExecutionToJob,
  claimNextJob,
  completeJob,
  enqueueWorkflowJob,
  failJob,
  heartbeatJob,
  MAX_FREE_RECLAIMS,
  pruneWorkflowJobs,
  reclaimExpiredJobs,
} from "./jobs";
import { readQueueCounters, readQueueGauges } from "./metrics";

/**
 * The queue against a real Postgres, because every property that matters here is
 * a property of the DATABASE rather than of the code: a partial unique index
 * Prisma does not know about, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT DO
 * NOTHING`, server-side interval arithmetic, and what a unique violation does to
 * the transaction it happens in. Unit tests would prove none of it.
 *
 * The two tests worth reading first are the per-workflow race and the reclaim
 * refund arithmetic. The race is the one the whole design rests on; the refund
 * is the one that looks obviously right and is off by one.
 */

let userId: string;
let workflowId: string;
let otherWorkflowId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const minutesFromNow = (n: number) => new Date(Date.now() + n * 60_000);

async function newWorkflow(name: string) {
  const workflow = await prisma.workflow.create({
    data: { name, userId },
    select: { id: true },
  });
  return workflow.id;
}

type SeedOverrides = Partial<{
  workflowId: string;
  payload: Prisma.InputJsonObject;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  runAt: Date;
  attempt: number;
  reclaims: number;
  maxAttempts: number;
  lockedBy: string;
  leaseExpiresAt: Date;
  idempotencyKey: string;
  executionId: string;
}>;

/** A job row placed by hand, so each test starts from an exact state. */
function seedJob(overrides: SeedOverrides = {}) {
  return prisma.workflowJob.create({
    data: {
      workflowId,
      payload: {},
      maxAttempts: 4,
      ...overrides,
    },
  });
}

const readJob = (id: string) =>
  prisma.workflowJob.findUniqueOrThrow({ where: { id } });

/**
 * Waits until some backend is blocked on a lock, which is how the race test
 * knows the second claim has actually reached its UPDATE and is waiting on the
 * partial index — rather than assuming it from a sleep.
 */
async function waitForBlockedStatement(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND state = 'active'
    `;
    if (row.n > 0) return true;
    await sleep(25);
  }
  return false;
}

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  userId = user.id;
  workflowId = await newWorkflow("queue");
  otherWorkflowId = await newWorkflow("queue-other");
});

afterAll(async () => {
  await cleanupDb();
});

describe("enqueue", () => {
  it("inserts a claimable job carrying the whole payload", async () => {
    const payload = {
      initialData: { from: "test" },
      idempotencyKey: "gmail:msg-1",
      replayFromNodeId: "node_x",
    };

    const result = await enqueueWorkflowJob({ workflowId, payload });
    expect(result).toEqual({ enqueued: true, jobId: expect.any(String) });

    const job = await readJob((result as { jobId: string }).jobId);
    expect(job.status).toBe("PENDING");
    expect(job.payload).toEqual(payload);
    // The column is DERIVED from the payload, never passed alongside it, so the
    // row and the payload cannot disagree about what this run dedups on.
    expect(job.idempotencyKey).toBe("gmail:msg-1");
    expect(job.attempt).toBe(0);
    expect(job.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    // A raw INSERT has to supply `id` and `updatedAt` itself — both are applied
    // by the Prisma client rather than by the database.
    expect(job.id).toBeTruthy();
    expect(job.updatedAt).toBeInstanceOf(Date);
  });

  it("defaults maxAttempts to the same policy the Inngest path uses", async () => {
    const result = await enqueueWorkflowJob({ workflowId, payload: {} });
    const job = await readJob((result as { jobId: string }).jobId);
    // Same number of tries whichever runtime a workflow is routed to.
    expect(job.maxAttempts).toBe(resolveWorkflowRetries() + 1);
  });

  it("drops a duplicate idempotency key without failing", async () => {
    const payload = { idempotencyKey: "gmail:msg-1" };
    expect(await enqueueWorkflowJob({ workflowId, payload })).toMatchObject({
      enqueued: true,
    });
    expect(await enqueueWorkflowJob({ workflowId, payload })).toEqual({
      enqueued: false,
      reason: "duplicate",
    });
    expect(await prisma.workflowJob.count()).toBe(1);
  });

  it("scopes the key to the workflow, and leaves keyless runs alone", async () => {
    const payload = { idempotencyKey: "sheet:row-7" };
    // Two workflows watching the same sheet legitimately both handle the same
    // event — the same reasoning as Execution's own scoped constraint.
    await enqueueWorkflowJob({ workflowId, payload });
    await enqueueWorkflowJob({ workflowId: otherWorkflowId, payload });

    // Nulls are distinct in Postgres, so manual runs, reruns and replays never
    // collide with each other.
    await enqueueWorkflowJob({ workflowId, payload: {} });
    await enqueueWorkflowJob({ workflowId, payload: {} });

    expect(await prisma.workflowJob.count()).toBe(4);
  });

  it("can sit inside the caller's transaction", async () => {
    // The capability an off-the-shelf queue could not give us: enqueue has to be
    // able to commit or roll back together with the caller's own decision.
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueWorkflowJob({ workflowId, payload: {}, client: tx });
        throw new Error("caller changed its mind");
      }),
    ).rejects.toThrow("caller changed its mind");

    expect(await prisma.workflowJob.count()).toBe(0);
  });
});

describe("claim", () => {
  it("takes the oldest claimable job and leases it", async () => {
    const older = await seedJob({ runAt: minutesAgo(5) });
    await seedJob({ workflowId: otherWorkflowId, runAt: minutesAgo(1) });

    const claimed = await claimNextJob({ workerId: "worker-1" });

    expect(claimed?.id).toBe(older.id);
    expect(claimed?.status).toBe("RUNNING");
    expect(claimed?.lockedBy).toBe("worker-1");
    expect(claimed?.maxAttempts).toBe(4);
    // `attempt` counts CLAIMS, not failures, so a job that kills its worker
    // outright still terminates instead of looping forever.
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("hands back the payload intact, decoded the same way the row reads", async () => {
    // The one field the worker actually consumes, and the one the other claim
    // assertions cannot cover: `claimNextJob` returns `RETURNING j.*` through
    // $queryRaw, which bypasses Prisma's model mapping entirely. If the raw path
    // ever handed the jsonb column back as a string, or shaped differently from
    // a findUnique, the worker would deserialize garbage and every other test
    // here would stay green.
    const payload = {
      initialData: { rows: [{ id: 1 }], nested: { deep: true } },
      idempotencyKey: "sheet:row-7",
      fanOutChain: {
        nodeId: "node_a",
        outputKey: "GOOGLE_SHEETS_1",
        index: 3,
        total: 10,
        executionId: "exec_parent",
        onItemFailure: "continue" as const,
      },
    };
    const seeded = await seedJob({ runAt: minutesAgo(1), payload });

    const claimed = await claimNextJob({ workerId: "worker-1" });

    expect(claimed?.payload).toEqual(payload);
    // ...and identical to what the query builder reads back from the same row.
    expect(claimed?.payload).toEqual((await readJob(seeded.id)).payload);
  });

  it("leaves a job scheduled for the future alone", async () => {
    await seedJob({ runAt: minutesFromNow(5) });
    expect(await claimNextJob({ workerId: "worker-1" })).toBeNull();
  });

  it("returns null on an empty queue rather than throwing", async () => {
    expect(await claimNextJob({ workerId: "worker-1" })).toBeNull();
  });

  it("never takes a second job of a workflow that is already running", async () => {
    // The fast filter. One workflow, two jobs, one worker: the second job waits
    // for the first to finish, which is what replaces Inngest's
    // concurrency: { key: workflowId, limit: 1 }.
    await seedJob({ runAt: minutesAgo(5) });
    await seedJob({ runAt: minutesAgo(4) });

    expect(await claimNextJob({ workerId: "worker-1" })).not.toBeNull();
    expect(await claimNextJob({ workerId: "worker-2" })).toBeNull();
    expect(
      await prisma.workflowJob.count({ where: { status: "RUNNING" } }),
    ).toBe(1);
  });

  it("loses the race to the index, then claims elsewhere in a FRESH transaction", async () => {
    // THE test the partial unique index exists for, made deterministic.
    //
    // Worker A takes jobA1 inside a transaction we hold open, so its RUNNING row
    // is uncommitted. Worker B's NOT EXISTS filter therefore cannot see it —
    // this is exactly the window SKIP LOCKED opens and the filter alone cannot
    // close — so B picks jobA2 and blocks on the index entry A has not committed
    // yet. When A commits, B's UPDATE raises the unique violation.
    const jobA1 = await seedJob({ runAt: minutesAgo(3) });
    await seedJob({ runAt: minutesAgo(2) });
    const jobB = await seedJob({
      workflowId: otherWorkflowId,
      runAt: minutesAgo(1),
    });

    let release: () => void = () => {};
    let updated: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const updateLanded = new Promise<void>((r) => {
      updated = r;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          UPDATE "WorkflowJob"
          SET status = 'RUNNING'::"JobStatus",
              "lockedBy" = 'worker-a',
              "leaseExpiresAt" = now() + interval '60 seconds',
              "updatedAt" = now()
          WHERE id = ${jobA1.id}
        `;
        updated();
        await held;
      },
      { timeout: 20_000 },
    );

    await updateLanded;
    const conflictsBefore = readQueueCounters().claimConflicts;

    const claiming = claimNextJob({ workerId: "worker-b" });
    // Proven, not assumed: worker B is genuinely parked on the index.
    expect(await waitForBlockedStatement()).toBe(true);

    release();
    await holder;
    const claimed = await claiming;

    // It did not get a second job of workflow A...
    expect(claimed?.id).toBe(jobB.id);
    expect(claimed?.workflowId).toBe(otherWorkflowId);
    // ...and it got there by losing the race and trying again.
    expect(readQueueCounters().claimConflicts).toBe(conflictsBefore + 1);

    // ⚠️ The retry had to happen in a NEW transaction. A unique violation aborts
    // the transaction it occurs in, so a retry loop inside one would have come
    // back with `25P02 current transaction is aborted` instead of a job — a
    // failure that looks like a database fault and only appears once two workers
    // actually collide.
    expect(
      await prisma.workflowJob.count({ where: { status: "RUNNING" } }),
    ).toBe(2);
  });

  it("lets exactly one of many concurrent workers win a workflow", async () => {
    for (let i = 0; i < 6; i++) await seedJob({ runAt: minutesAgo(6 - i) });

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claimNextJob({ workerId: `worker-${i}` }),
      ),
    );

    // At most one by the index, at least one because the queue is not empty.
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await prisma.workflowJob.count({ where: { status: "RUNNING" } }),
    ).toBe(1);
  });
});

describe("heartbeat", () => {
  it("extends the lease of a job this worker still holds", async () => {
    const job = await seedJob({
      status: "RUNNING",
      lockedBy: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 5_000),
    });

    const result = await heartbeatJob({ jobId: job.id, workerId: "worker-1" });

    expect(result.held).toBe(true);
    expect((await readJob(job.id)).leaseExpiresAt?.getTime()).toBeGreaterThan(
      Date.now() + 30_000,
    );
  });

  it("reports a stolen lease, and does not renew it", async () => {
    // Zero rows updated is the fence. Without it, reclaim manufactures two
    // processes running one execution against the same spreadsheet.
    const job = await seedJob({ status: "RUNNING", lockedBy: "worker-2" });

    const before = readQueueCounters().fences["lease-stolen"];
    const result = await heartbeatJob({ jobId: job.id, workerId: "worker-1" });

    expect(result).toEqual({ held: false, reason: "lease-stolen" });
    expect(readQueueCounters().fences["lease-stolen"]).toBe(before + 1);
    expect((await readJob(job.id)).lockedBy).toBe("worker-2");
  });

  it("tells a vanished job row apart from a stolen lease", async () => {
    // §9.17: deleting a workflow mid-run cascades the job row away, and the
    // heartbeat then fails for a completely different reason. Both abort the
    // run; naming them apart is what keeps the log line honest — one points at
    // an unhealthy host, the other at a workflow deleted under a live run.
    const job = await seedJob({ status: "RUNNING", lockedBy: "worker-1" });
    const before = readQueueCounters().fences["job-row-gone"];

    await prisma.workflow.delete({ where: { id: workflowId } });

    expect(await heartbeatJob({ jobId: job.id, workerId: "worker-1" })).toEqual(
      {
        held: false,
        reason: "job-row-gone",
      },
    );
    expect(readQueueCounters().fences["job-row-gone"]).toBe(before + 1);
  });

  it("reports a job that is no longer RUNNING", async () => {
    // The reaper took it back (or it was cancelled): still ours by `lockedBy`,
    // but not ours to work on.
    const job = await seedJob({ status: "PENDING", lockedBy: "worker-1" });

    expect(await heartbeatJob({ jobId: job.id, workerId: "worker-1" })).toEqual(
      {
        held: false,
        reason: "not-running",
      },
    );
  });
});

describe("attach, complete", () => {
  it("records the execution id as soon as the run's row exists", async () => {
    const job = await seedJob({ status: "RUNNING", lockedBy: "worker-1" });

    expect(
      await attachExecutionToJob({
        jobId: job.id,
        workerId: "worker-1",
        executionId: "exec_1",
      }),
    ).toBe(true);
    expect((await readJob(job.id)).executionId).toBe("exec_1");
  });

  it("refuses to write anything for a worker that no longer owns the job", async () => {
    const job = await seedJob({ status: "RUNNING", lockedBy: "worker-2" });

    expect(
      await attachExecutionToJob({
        jobId: job.id,
        workerId: "worker-1",
        executionId: "exec_1",
      }),
    ).toBe(false);
    expect(await completeJob({ jobId: job.id, workerId: "worker-1" })).toBe(
      false,
    );

    const row = await readJob(job.id);
    expect(row.status).toBe("RUNNING");
    expect(row.executionId).toBeNull();
  });

  it("marks a finished job SUCCEEDED and releases the lease", async () => {
    const job = await seedJob({
      status: "RUNNING",
      lockedBy: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(await completeJob({ jobId: job.id, workerId: "worker-1" })).toBe(
      true,
    );

    const row = await readJob(job.id);
    expect(row.status).toBe("SUCCEEDED");
    expect(row.lockedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
  });
});

describe("fail", () => {
  const running = (overrides: SeedOverrides = {}) =>
    seedJob({
      status: "RUNNING",
      lockedBy: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attempt: 1,
      ...overrides,
    });

  it("schedules a retry with backoff and releases the lease", async () => {
    const job = await running();

    const result = await failJob({
      job,
      workerId: "worker-1",
      error: new Error("upstream 503"),
      random: () => 1, // the ceiling, so the schedule is exact
    });

    expect(result).toMatchObject({
      outcome: "retry-scheduled",
      delayMs: 10_000,
    });
    const row = await readJob(job.id);
    expect(row.status).toBe("PENDING");
    expect(row.lockedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.lastError).toBe("upstream 503");
    // Computed by Postgres from Postgres' clock, so "did this run on time" never
    // depends on the container's clock matching the database's.
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 8_000);
  });

  it("waits at least as long as a RetryAfterError asks", async () => {
    // How Google's and Microsoft's rate limits are respected. Ignoring this
    // points our retry storm at a client's Sheets quota.
    const job = await running();

    const result = await failJob({
      job,
      workerId: "worker-1",
      error: new RetryAfterError("rate limited", "30s"),
      random: () => 0, // backoff would otherwise be 0
    });

    expect(result).toMatchObject({
      outcome: "retry-scheduled",
      delayMs: 30_000,
    });
    expect((await readJob(job.id)).runAt.getTime()).toBeGreaterThan(
      Date.now() + 25_000,
    );
  });

  it("FLOORS at the computed backoff — a short retry-after cannot shorten it", async () => {
    // The direction that matters: obeying "come back in 1s" as an upper bound
    // would turn a rate limit into a tight loop against it.
    const job = await running({ attempt: 2 }); // ceiling 20s

    const result = await failJob({
      job,
      workerId: "worker-1",
      error: new RetryAfterError("slow down", "1s"),
      random: () => 1,
    });

    expect(result).toMatchObject({
      outcome: "retry-scheduled",
      delayMs: 20_000,
    });
  });

  it("spends every remaining attempt on a NonRetriableError", async () => {
    // A config or validation failure is not going to succeed on attempt 3, and
    // a row reading "attempt 1 of 4" beside status FAILED looks like a queue
    // that forgot to retry.
    const job = await running({ attempt: 1, maxAttempts: 4 });

    expect(
      await failJob({
        job,
        workerId: "worker-1",
        error: new NonRetriableError("missing credential"),
      }),
    ).toEqual({ outcome: "exhausted" });

    const row = await readJob(job.id);
    expect(row.status).toBe("FAILED");
    expect(row.attempt).toBe(4);
    expect(row.lastError).toBe("missing credential");
  });

  it("gives up once the attempts are spent", async () => {
    const job = await running({ attempt: 4, maxAttempts: 4 });

    expect(
      await failJob({ job, workerId: "worker-1", error: new Error("nope") }),
    ).toEqual({ outcome: "exhausted" });
    expect((await readJob(job.id)).status).toBe("FAILED");
  });

  it("writes nothing when this worker has been fenced", async () => {
    // A fenced worker must not mark FAILED a run another worker is at that
    // moment executing successfully.
    const job = await running({ lockedBy: "worker-2" });

    expect(
      await failJob({ job, workerId: "worker-1", error: new Error("nope") }),
    ).toEqual({ outcome: "not-owned" });

    const row = await readJob(job.id);
    expect(row.status).toBe("RUNNING");
    expect(row.lastError).toBeNull();
  });

  it("survives an error message containing a NUL byte", async () => {
    // Postgres rejects \u0000 in a text value, so an unstripped one would make
    // this UPDATE throw while HANDLING a failure — leaving the job RUNNING with
    // its lease held and nothing recorded, until the reaper re-ran its side
    // effects. Reachable from a binary response fragment or Code node output.
    const job = await running();

    const result = await failJob({
      job,
      workerId: "worker-1",
      error: new Error("provider said\u0000 something binary"),
      random: () => 1,
    });

    expect(result).toMatchObject({ outcome: "retry-scheduled" });
    expect((await readJob(job.id)).lastError).toBe(
      "provider said something binary",
    );
  });

  it("truncates a huge error rather than storing it whole", async () => {
    const job = await running();
    await failJob({
      job,
      workerId: "worker-1",
      error: new Error("x".repeat(10_000)),
    });
    expect((await readJob(job.id)).lastError?.length).toBeLessThan(4_100);
  });
});

describe("reclaim", () => {
  /**
   * A job whose worker died: RUNNING, owned, lease already past. Mirrors the
   * `running()` helper in the block above so each test below states only the
   * fields it is actually about — which is what makes the one field that varies
   * (`attempt`, `reclaims`, `maxAttempts`) visible at a glance.
   */
  const abandoned = (overrides: SeedOverrides = {}) =>
    seedJob({
      status: "RUNNING",
      lockedBy: "dead",
      leaseExpiresAt: minutesAgo(1),
      ...overrides,
    });

  it("returns an expired lease to the queue, immediately claimable", async () => {
    const job = await abandoned({ executionId: "exec_1", attempt: 1 });

    expect(await reclaimExpiredJobs()).toEqual({ reclaimed: 1, exhausted: [] });

    const row = await readJob(job.id);
    expect(row.status).toBe("PENDING");
    expect(row.lockedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    // Keeping the execution id is what makes a reclaim a RESUME: the run's
    // stored steps are memoized against it, so the retry fast-forwards to where
    // it stopped instead of re-executing side effects.
    expect(row.executionId).toBe("exec_1");

    expect(await claimNextJob({ workerId: "worker-2" })).not.toBeNull();
  });

  it("leaves a live lease alone", async () => {
    await seedJob({
      status: "RUNNING",
      lockedBy: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await reclaimExpiredJobs()).toEqual({ reclaimed: 0, exhausted: [] });
  });

  it("rescues a RUNNING job that has no lease at all", async () => {
    // Nothing writes this row today. It is guarded because NULL < now() is NULL,
    // so such a row would otherwise be stuck RUNNING forever with no owner.
    const job = await seedJob({ status: "RUNNING", lockedBy: "worker-1" });
    expect(await reclaimExpiredJobs()).toEqual({ reclaimed: 1, exhausted: [] });
    expect((await readJob(job.id)).status).toBe("PENDING");
  });

  it("reaches a lease-less job even behind a full batch of expired ones", async () => {
    // Postgres sorts NULLs LAST by default, so without NULLS FIRST the row the
    // clause above goes out of its way to rescue sorts behind every expired
    // lease and never fits inside the batch limit — stuck forever, which is the
    // exact state the guard exists to prevent.
    const noLease = await seedJob({ status: "RUNNING", lockedBy: "worker-1" });
    await abandoned({
      workflowId: otherWorkflowId,
      leaseExpiresAt: minutesAgo(5),
    });

    expect(await reclaimExpiredJobs({ limit: 1 })).toEqual({
      reclaimed: 1,
      exhausted: [],
    });
    expect((await readJob(noLease.id)).status).toBe("PENDING");
  });

  it("KILLS a job that has used every attempt, rather than reclaiming it forever", async () => {
    // The poison-job case, and the only thing that terminates it.
    //
    // A run that OOMs its worker never reaches `failJob` — nothing survives to
    // call it — so `maxAttempts` cannot be enforced there alone. Without this,
    // the cycle is reclaim -> claim -> die -> reclaim at reaper cadence forever,
    // and because of the partial unique index that job holds its workflow's one
    // RUNNING slot on every pass, starving every other run that client queued.
    const poison = await abandoned({
      attempt: 4,
      maxAttempts: 4,
      reclaims: MAX_FREE_RECLAIMS, // past the refunds
      executionId: "exec_poison",
      payload: { idempotencyKey: "poison-1" },
    });

    // The ROWS, not a count — the caller has to settle each one's `Execution`,
    // and cannot do that from a number. Without this the user's run reads
    // RUNNING forever: the job is correctly FAILED, but nothing told the run.
    expect(await reclaimExpiredJobs()).toEqual({
      reclaimed: 0,
      exhausted: [
        {
          id: poison.id,
          executionId: "exec_poison",
          workflowId,
          payload: { idempotencyKey: "poison-1" },
        },
      ],
    });

    const row = await readJob(poison.id);
    // FAILED, not "PENDING but unclaimable": a row no worker will ever take is
    // the silently-stuck state this module exists to make impossible.
    expect(row.status).toBe("FAILED");
    expect(row.lockedBy).toBeNull();
    expect(row.lastError).toContain("stopped responding");
    expect(await claimNextJob({ workerId: "worker-2" })).toBeNull();

    // Still counted as a lease loss — a death is not a milder symptom of an
    // unhealthy host than a handover is.
    expect(row.reclaims).toBe(MAX_FREE_RECLAIMS + 1);
  });

  it("does not kill a job whose refund leaves it an attempt", async () => {
    // The boundary the one above must not overshoot: same spent attempt count,
    // but this reclaim is still free, so the refund puts it back under the cap
    // and the job lives.
    const job = await abandoned({ attempt: 4, maxAttempts: 4, reclaims: 0 });

    expect(await reclaimExpiredJobs()).toEqual({ reclaimed: 1, exhausted: [] });
    expect(await readJob(job.id)).toMatchObject({
      status: "PENDING",
      attempt: 3,
    });
  });

  it("refunds the attempt for the first two reclaims and no more", async () => {
    // THE boundary. A rolling deploy, a GC pause or a brief partition each end
    // in a reclaim with zero genuine failures, and at maxAttempts 4 a bad
    // afternoon would otherwise exhaust a perfectly healthy job. Past the free
    // ones it stops refunding, which is what still terminates a job that kills
    // its worker every single time.
    //
    // Three separate workflows because the partial unique index physically
    // forbids two RUNNING jobs of one workflow.
    const first = await abandoned({ attempt: 3, reclaims: 0 });
    const second = await abandoned({
      workflowId: otherWorkflowId,
      attempt: 3,
      reclaims: MAX_FREE_RECLAIMS - 1,
    });
    const third = await abandoned({
      workflowId: await newWorkflow("queue-third"),
      attempt: 3,
      reclaims: MAX_FREE_RECLAIMS,
    });

    const countersBefore = readQueueCounters().reclaims;
    expect(await reclaimExpiredJobs()).toEqual({ reclaimed: 3, exhausted: [] });

    expect(await readJob(first.id)).toMatchObject({ attempt: 2, reclaims: 1 });
    expect(await readJob(second.id)).toMatchObject({
      attempt: 2,
      reclaims: MAX_FREE_RECLAIMS,
    });
    // Past the free ones: the reclaim still counts, but the attempt is not
    // given back.
    expect(await readJob(third.id)).toMatchObject({
      attempt: 3,
      reclaims: MAX_FREE_RECLAIMS + 1,
    });

    expect(readQueueCounters().reclaims).toBe(countersBefore + 3);
  });

  it("never refunds an attempt below zero", async () => {
    const job = await abandoned({ attempt: 0 });
    await reclaimExpiredJobs();
    expect((await readJob(job.id)).attempt).toBe(0);
  });

  it("honours its batch limit", async () => {
    await abandoned({ leaseExpiresAt: minutesAgo(2) });
    await abandoned({ workflowId: otherWorkflowId });

    expect(await reclaimExpiredJobs({ limit: 1 })).toMatchObject({
      reclaimed: 1,
    });
    expect(await reclaimExpiredJobs({ limit: 1 })).toMatchObject({
      reclaimed: 1,
    });
    expect(await reclaimExpiredJobs({ limit: 1 })).toMatchObject({
      reclaimed: 0,
    });
  });
});

describe("retention and cascades", () => {
  it("is deleted with its workflow, and so with its user", async () => {
    // Asserted rather than assumed: `cleanupDb` deletes users and relies on
    // cascades, and the daily prune will need the same property.
    await seedJob();
    await seedJob({ workflowId: otherWorkflowId });
    expect(await prisma.workflowJob.count()).toBe(2);

    await prisma.workflow.delete({ where: { id: workflowId } });
    expect(await prisma.workflowJob.count()).toBe(1);

    await cleanupDb();
    expect(await prisma.workflowJob.count()).toBe(0);
  });
});

describe("metrics", () => {
  it("counts the queue by what a worker could actually take", async () => {
    await seedJob({ runAt: minutesAgo(9) });
    await seedJob({ workflowId: otherWorkflowId, runAt: minutesFromNow(30) });
    await seedJob({
      workflowId: await newWorkflow("m-running"),
      status: "RUNNING",
      lockedBy: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await seedJob({
      workflowId: await newWorkflow("m-expired"),
      status: "RUNNING",
      lockedBy: "dead",
      leaseExpiresAt: minutesAgo(1),
    });
    await seedJob({
      workflowId: await newWorkflow("m-failed"),
      status: "FAILED",
    });

    const gauges = await readQueueGauges();

    expect(gauges.pending).toBe(2);
    // The backed-off job is waiting on purpose and is not a backlog.
    expect(gauges.claimable).toBe(1);
    expect(gauges.running).toBe(2);
    // Nothing is reaping in this test, which is precisely what this gauge says.
    expect(gauges.expiredLeases).toBe(1);
    expect(gauges.failedInWindow).toBe(1);
    // Every count is a JS number: `count(*)` is bigint, which arrives as a
    // BigInt and would throw on JSON.stringify in a metrics line.
    expect(typeof gauges.pending).toBe("number");
  });

  it("ages the oldest CLAIMABLE job, which is the number an alert is built on", async () => {
    await seedJob({ runAt: minutesAgo(9) });
    await seedJob({ workflowId: otherWorkflowId, runAt: minutesAgo(2) });

    const { oldestClaimableAgeMs } = await readQueueGauges();

    expect(oldestClaimableAgeMs).toBeGreaterThan(8.5 * 60_000);
    expect(oldestClaimableAgeMs).toBeLessThan(9.5 * 60_000);
  });

  it("reports no age when nothing is waiting to run", async () => {
    // A job scheduled for later is not late, so it must not register as one.
    await seedJob({ runAt: minutesFromNow(30) });
    expect((await readQueueGauges()).oldestClaimableAgeMs).toBeNull();
  });

  it("excludes jobs that failed outside the window", async () => {
    const job = await seedJob({ status: "FAILED" });
    await prisma.$executeRaw`
      UPDATE "WorkflowJob" SET "updatedAt" = now() - interval '3 hours'
      WHERE id = ${job.id}
    `;
    expect((await readQueueGauges({ windowMinutes: 60 })).failedInWindow).toBe(
      0,
    );
  });
});

describe("pruneWorkflowJobs", () => {
  /**
   * Retention is the thing that keeps the two runtimes agreeing, not just
   * housekeeping — see `src/execution/retention.ts`. The windows are reached by
   * moving `now` forward rather than by back-dating rows, so every fixture here
   * is a row in exactly the state the real code writes.
   */
  const daysFromNow = (n: number) =>
    new Date(Date.now() + n * 24 * 60 * 60 * 1000);

  it("deletes a SUCCEEDED job once past its window", async () => {
    const job = await seedJob({ status: "SUCCEEDED" });

    expect(await pruneWorkflowJobs({ now: daysFromNow(1) })).toEqual({
      deleted: 0,
    });
    expect(await readJob(job.id)).toBeTruthy();

    expect(
      await pruneWorkflowJobs({
        now: daysFromNow(SUCCEEDED_JOB_RETENTION_DAYS + 1),
      }),
    ).toEqual({ deleted: 1 });
    expect(
      await prisma.workflowJob.findUnique({ where: { id: job.id } }),
    ).toBeNull();
  });

  it("keeps a FAILED job for the full execution window", async () => {
    const job = await seedJob({ status: "FAILED" });

    // Past the SUCCEEDED window but well inside its own: the case that would
    // break if the three statuses shared one cutoff.
    await pruneWorkflowJobs({
      now: daysFromNow(SUCCEEDED_JOB_RETENTION_DAYS + 1),
    });
    expect(await readJob(job.id)).toBeTruthy();

    expect(
      await pruneWorkflowJobs({
        now: daysFromNow(FAILED_JOB_RETENTION_DAYS + 1),
      }),
    ).toEqual({ deleted: 1 });
  });

  it("never deletes a job that is still in play", async () => {
    // No age makes deleting these correct. A RUNNING row removed from under its
    // worker fences that worker (`job-row-gone`) — a real abort caused by a
    // housekeeping job — and a PENDING row deleted is a trigger silently lost.
    const pending = await seedJob({ status: "PENDING" });
    const running = await seedJob({
      workflowId: otherWorkflowId,
      status: "RUNNING",
      lockedBy: "worker-1",
      leaseExpiresAt: minutesFromNow(1),
    });

    expect(await pruneWorkflowJobs({ now: daysFromNow(365) })).toEqual({
      deleted: 0,
    });
    expect(await readJob(pending.id)).toBeTruthy();
    expect(await readJob(running.id)).toBeTruthy();
  });

  it("frees the idempotency key it was holding", async () => {
    // The reason the window exists at all. While the row survives it dedups its
    // key; once pruned, the same external event can be enqueued again — which
    // is what stops the worker dropping a key Inngest would run.
    await seedJob({ status: "SUCCEEDED", idempotencyKey: "gmail:m1" });

    const blocked = await enqueueWorkflowJob({
      workflowId,
      payload: { idempotencyKey: "gmail:m1" },
    });
    expect(blocked).toEqual({ enqueued: false, reason: "duplicate" });

    await pruneWorkflowJobs({
      now: daysFromNow(SUCCEEDED_JOB_RETENTION_DAYS + 1),
    });

    const allowed = await enqueueWorkflowJob({
      workflowId,
      payload: { idempotencyKey: "gmail:m1" },
    });
    expect(allowed.enqueued).toBe(true);
  });

  it("drains past a single batch in one call", async () => {
    // The reason the batch is not the whole story: capping a call at one batch
    // capped RETENTION at one batch per day, so any install producing more
    // terminal jobs than that per day grew forever — the exact failure pruning
    // exists to prevent. One call must drain the backlog, not defer it.
    for (let i = 0; i < 3; i++) {
      await seedJob({ status: "SUCCEEDED", idempotencyKey: `k${i}` });
    }

    expect(
      await pruneWorkflowJobs({
        now: daysFromNow(SUCCEEDED_JOB_RETENTION_DAYS + 1),
        limit: 2,
      }),
    ).toEqual({ deleted: 3 });
  });

  it("still bounds one call, so a backlog cannot become an unbounded write", async () => {
    // The other half: draining must not mean "delete until finished". This is
    // a table the claim loop reads every few hundred milliseconds.
    for (let i = 0; i < 5; i++) {
      await seedJob({ status: "SUCCEEDED", idempotencyKey: `b${i}` });
    }

    expect(
      await pruneWorkflowJobs({
        now: daysFromNow(SUCCEEDED_JOB_RETENTION_DAYS + 1),
        limit: 2,
        maxBatches: 2,
      }),
    ).toEqual({ deleted: 4 });

    // The remainder survives to the next call rather than being deleted in a
    // loop that does not stop.
    expect(await prisma.workflowJob.count({ where: { workflowId } })).toBe(1);
  });
});
