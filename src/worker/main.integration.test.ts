import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeType } from "@/generated/prisma";
import prisma from "@/lib/db";
import { enqueueWorkflowJob } from "@/queue/jobs";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";

/**
 * The worker as an actual PROCESS.
 *
 * `run-job.integration.test.ts` proves what happens to one job. This proves the
 * thing no in-process test can: that `npm run worker:dev` boots at all — that
 * the module graph loads under `tsx`, the boot assertion passes, the claim loop
 * finds work nobody handed it, and a `SIGTERM` ends the process rather than
 * stranding it.
 *
 * It runs the REAL executor registry, so the workflow under test is a lone
 * `MANUAL_TRIGGER` — the one node that reaches no external service and needs no
 * credential.
 *
 * ⚠️ **The signal test cannot run on Windows.** Node does not deliver POSIX
 * signals there; `child.kill("SIGTERM")` calls `TerminateProcess`, so the
 * handler never runs and the assertion would be about Windows rather than about
 * the worker. CI is `ubuntu-latest`, which is where it actually executes.
 */

const WORKER_ENTRY = path.resolve(process.cwd(), "src/worker/main.ts");
const TSX_CLI = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
/**
 * ⚠️ Not optional, and its absence is what this file exists to catch. The
 * worker's module graph reaches three modules that `import "server-only"`,
 * whose main entry throws outside a React Server Component — so without this
 * mapping the process dies on import, before its first log line. Both vitest
 * configs alias the same package, which is precisely why no in-process test
 * could ever have found it.
 */
const WORKER_TSCONFIG = path.resolve(process.cwd(), "tsconfig.worker.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let userId: string;
let workflowId: string;
let child: ChildProcess | undefined;
let output = "";

beforeEach(async () => {
  await cleanupDb();
  output = "";
  userId = (await createTestUser()).id;

  const workflow = await prisma.workflow.create({
    data: { name: "worker process", userId },
    select: { id: true },
  });
  workflowId = workflow.id;

  // One trigger, nothing downstream: enough to produce a real run end to end.
  await prisma.node.create({
    data: {
      workflowId,
      type: NodeType.MANUAL_TRIGGER,
      name: "Manual trigger",
      position: { x: 0, y: 0 },
      data: {},
    },
  });
});

afterEach(async () => {
  // ⚠️ AWAITED before `cleanupDb`. `kill` only delivers the signal — it does
  // not wait for the process to die — so truncating immediately would race the
  // worker's still-open claim/reaper/metrics statements for locks on
  // `WorkflowJob`. That surfaces as an intermittent CI failure in the NEXT
  // test, reading as a worker bug rather than as teardown.
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => {
      child?.once("exit", () => resolve());
    });
    child.kill("SIGKILL");
    await exited;
  }
  child = undefined;
  await cleanupDb();
});

/** Boots the worker exactly as `npm run worker:dev` does, minus dotenv. */
function startWorker(): ChildProcess {
  const proc = spawn(
    process.execPath,
    [TSX_CLI, "--tsconfig", WORKER_TSCONFIG, WORKER_ENTRY],
    {
      env: {
        ...process.env,
        // The container the integration harness provisioned.
        DATABASE_URL: process.env.DATABASE_URL,
        DIRECT_URL: process.env.DIRECT_URL,
        // Real enough to pass `isRealEnvValue` — the boot assertion rejects an
        // `.env.example` placeholder, which is the point of it.
        ENCRYPTION_KEY: "integration-test-encryption-key",
        WORKER_CONCURRENCY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  proc.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  proc.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  return proc;
}

/** Polls until `predicate` holds, so nothing here depends on a fixed sleep. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}. Worker output:\n${output}`);
}

const waitForBoot = () =>
  waitFor(() => output.includes("Worker starting"), "the worker to boot");

describe("the worker process", () => {
  it("boots, claims a job nobody handed it, runs it and completes it", async () => {
    child = startWorker();
    await waitForBoot();

    // Step 6 is what routes real triggers here. Until then the queue row IS the
    // interface, which is exactly how this step is meant to be driven.
    const enqueued = await enqueueWorkflowJob({
      workflowId,
      payload: { initialData: { from: "the process test" } },
    });
    expect(enqueued.enqueued).toBe(true);

    await waitFor(async () => {
      const job = await prisma.workflowJob.findFirst({ where: { workflowId } });
      return job?.status === "SUCCEEDED";
    }, "the job to be completed by the worker");

    const job = await prisma.workflowJob.findFirstOrThrow({
      where: { workflowId },
    });
    expect(job.executionId).not.toBeNull();
    expect(job.lockedBy).toBeNull();

    const run = await prisma.execution.findUniqueOrThrow({
      where: { id: job.executionId as string },
    });
    expect(run.status).toBe("SUCCESS");
    // The synthetic id, proving this really came through the worker path.
    expect(run.inngestEventId).toBe(`job_${job.id}`);

    const nodes = await prisma.nodeExecution.findMany({
      where: { executionId: run.id },
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].status).toBe("SUCCESS");
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "stops claiming and exits cleanly on SIGTERM",
    async () => {
      // Without this, every deploy kills mid-flight runs. The container also has
      // to actually EXIT — a worker that ignores SIGTERM is SIGKILLed by the
      // orchestrator after its own grace period, which is the ungraceful
      // shutdown this exists to avoid.
      child = startWorker();
      await waitForBoot();

      const exited = new Promise<number | null>((resolve) => {
        child?.on("exit", (code) => resolve(code));
      });

      const sentAt = Date.now();
      child.kill("SIGTERM");

      const code = await Promise.race([
        exited,
        sleep(20_000).then(() => "timed-out" as const),
      ]);

      expect(code).toBe(0);
      // Promptly, not after the 120 s grace period: there was nothing in flight
      // to wait for, and a shutdown that always burns the full grace period
      // would make every deploy take two minutes.
      expect(Date.now() - sentAt).toBeLessThan(20_000);

      // The handler ran, rather than the process simply dying.
      expect(output).toContain("no new jobs will be claimed");
      expect(output).toContain("Worker stopped");

      // And it really did stop claiming: work queued after the signal is
      // untouched.
      await enqueueWorkflowJob({ workflowId, payload: {} });
      await sleep(500);
      const job = await prisma.workflowJob.findFirstOrThrow({
        where: { workflowId },
      });
      expect(job.status).toBe("PENDING");
      expect(job.lockedBy).toBeNull();
    },
    60_000,
  );
});
