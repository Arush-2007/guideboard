import type { Realtime } from "@inngest/realtime";
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

// The fan-out dispatcher and the chain advance both send real Inngest events.
// Captured rather than sent, so a fan-out assertion is about what the run
// DECIDED to dispatch rather than about Inngest being reachable.
const { sentExecutions } = vi.hoisted(() => ({
  sentExecutions: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/inngest/utils", () => ({
  sendWorkflowExecution: vi.fn(async (input: Record<string, unknown>) => {
    sentExecutions.push(input);
    return { ids: ["evt_fake"] };
  }),
}));

// One controllable executor for every node type. The engine, the recorder, the
// step store and `runExecution` itself are all REAL — only the leaf work is
// faked, so the property under test (a completed step never executes twice) is
// proven through the same code production runs.
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
import { ExecutionStatus, NodeType } from "@/generated/prisma";
import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { createWorkerStep } from "@/worker/worker-step";
import { passthroughRunStep, runExecution } from "./run-execution";

/**
 * The test the whole self-hosted runtime rests on.
 *
 * `runExecution` is the runtime-neutral body of `executeWorkflow`, and the
 * self-hosted worker resumes a reclaimed job by re-entering it from the top —
 * there is no HTTP replay to fast-forward through, only the durable step store.
 * So the guarantee has to be exactly this: **a completed step never executes
 * twice**, across a process death, against a real Postgres.
 *
 * The headline case models the Google Sheets append, whose executor splits
 * `google-sheets-append-plan` from `google-sheets-append-write` precisely
 * because replaying the plan after the write landed points one row lower and
 * appends a DUPLICATE row (see the `GOOGLE_SHEETS_ACTION` entry in
 * `src/config/node-kinds.ts`). `update_row` re-matching a filter against a sheet
 * its own update changed, and `style_cells` re-matching after `mergeCells`
 * collapsed the rows, are the same property.
 *
 * Runs under `npm run test:integration` only — it needs the container.
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

const publish = (async () => {}) as unknown as Realtime.PublishFn;

let userId: string;

beforeEach(async () => {
  await cleanupDb();
  sentExecutions.length = 0;
  executors.clear();
  userId = (await createTestUser()).id;

  // Triggers do no work; they only seed the context so downstream nodes run.
  executors.set(
    NodeType.MANUAL_TRIGGER,
    ({ context, outputKey }: FakeExecutorParams) => ({
      ...context,
      [outputKey]: { fired: true },
    }),
  );
});

/**
 * A trigger -> action workflow. The action is `GOOGLE_SHEETS_ACTION` because
 * that type is checkpointed by the engine (`CHECKPOINTED_NODE_TYPES`), which is
 * what gives its executor the real step rather than the inline shim.
 */
async function buildWorkflow() {
  const action = NodeType.GOOGLE_SHEETS_ACTION;
  const workflow = await prisma.workflow.create({
    data: { name: "crash resume", userId },
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
        type: action,
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

/**
 * Exactly the wiring Step 5's worker will use.
 *
 * Typed against `runExecution`'s own parameter object rather than
 * `Record<string, unknown>`, so a typo'd override is a compile error instead of
 * a silently-dropped key that leaves the test passing for the wrong reason.
 */
type RunExecutionArgs = Parameters<typeof runExecution>[0];

const asWorker = (overrides: Partial<RunExecutionArgs> = {}) => ({
  runStep: passthroughRunStep,
  engineStepFor: (executionId: string) => createWorkerStep({ executionId }),
  publish,
  ...overrides,
});

describe("runExecution — the Sheets plan/write crash-resume", () => {
  it("does not re-run a completed plan step, and writes once at the planned row", async () => {
    const { workflowId, actionNodeId } = await buildWorkflow();

    const planCalls: number[] = [];
    const writes: number[] = [];
    let crash = true;

    executors.set(NodeType.GOOGLE_SHEETS_ACTION, async (params) => {
      const { step, context, outputKey } = params;

      // The read that chooses where to write. On a resume this must be served
      // from the store — re-deriving it against a sheet the write already
      // changed is the duplicate-row bug.
      const plan = (await step.run("google-sheets-append-plan", async () => {
        planCalls.push(Date.now());
        // 7 on the first call; a re-derivation after the write would answer 8.
        return { row: 7 + writes.length };
      })) as { row: number };

      // The process dies here on the first attempt: after the plan committed,
      // before the write. That is the exact window a reclaimed lease reopens.
      if (crash) throw new Error("the worker died between plan and write");

      await step.run("google-sheets-append-write", async () => {
        writes.push(plan.row);
        return { updatedRange: `Sheet1!A${plan.row}` };
      });

      return { ...context, [outputKey]: { row: plan.row } };
    });

    // ---- attempt 1: dies between the two steps -----------------------------
    await expect(
      runExecution({
        workflowId,
        inngestEventId: "job_crash_1",
        payload: {},
        ...asWorker(),
      }),
    ).rejects.toThrow("the worker died between plan and write");

    expect(planCalls).toHaveLength(1);
    expect(writes).toEqual([]);

    const created = await prisma.execution.findUniqueOrThrow({
      where: { inngestEventId: "job_crash_1" },
      select: { id: true },
    });

    // ---- attempt 2: the reclaimed job re-enters for the SAME execution -----
    // Same `inngestEventId`, because a reclaimed job keeps its id — which is
    // what makes `create-execution`'s upsert adopt the row rather than make a
    // second one.
    crash = false;
    const resumed = await runExecution({
      workflowId,
      inngestEventId: "job_crash_1",
      payload: {},
      ...asWorker(),
    });

    expect(resumed.skipped).toBe(false);

    // 1. The plan step did not execute a second time.
    expect(planCalls).toHaveLength(1);
    // 2. The write landed once, at the row the FIRST attempt planned. An 8 here
    //    would be the duplicate-row bug; two entries would be a double append.
    expect(writes).toEqual([7]);

    // 3. One `NodeExecution` per node — the stale FAILED row from attempt 1 is
    //    superseded, not duplicated.
    const rows = await prisma.nodeExecution.findMany({
      where: { executionId: created.id },
      select: { nodeId: true, status: true },
      orderBy: { sequence: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "SUCCESS")).toBe(true);
    expect(rows.filter((r) => r.nodeId === actionNodeId)).toHaveLength(1);

    // 4. One run, not two, and it is recorded successful.
    const executions = await prisma.execution.findMany({
      where: { workflowId },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe(ExecutionStatus.SUCCESS);
  });

  it("adopts the existing row when an attempt died before any step was stored", async () => {
    // Isolates `create-execution`'s upsert from the step store: this run crashes
    // with NOTHING memoized, so the only thing carrying the resume is the
    // `inngestEventId` identity. A plain `create` would strand the job on that
    // unique constraint for every remaining attempt — a transient fault turned
    // permanent, which is the hole the ordinary arm carried until Step 4.
    const { workflowId } = await buildWorkflow();

    let crash = true;
    executors.set(NodeType.GOOGLE_SHEETS_ACTION, async (params) => {
      if (crash) throw new Error("died before attach");
      return { ...params.context, [params.outputKey]: { ok: true } };
    });

    await expect(
      runExecution({
        workflowId,
        inngestEventId: "job_no_attach",
        payload: {},
        ...asWorker(),
      }),
    ).rejects.toThrow("died before attach");

    crash = false;
    // NOTE: no `adoptExecutionId` — the whole point of this case.
    const resumed = await runExecution({
      workflowId,
      inngestEventId: "job_no_attach",
      payload: {},
      ...asWorker(),
    });

    expect(resumed.skipped).toBe(false);
    const executions = await prisma.execution.findMany({
      where: { workflowId },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0].status).toBe(ExecutionStatus.SUCCESS);
  });

  it("reports the execution id as soon as the row exists, not at completion", async () => {
    // `onExecutionCreated` is how the worker records the id on its job row, and
    // it has to fire before anything failable runs — otherwise a failure mid-run
    // has nothing to be attributed to, which is the gap Inngest's `onFailure`
    // has today.
    const { workflowId } = await buildWorkflow();
    const reported: string[] = [];

    executors.set(NodeType.GOOGLE_SHEETS_ACTION, () => {
      throw new Error("failed after the row existed");
    });

    await expect(
      runExecution({
        workflowId,
        inngestEventId: "job_attach_order",
        payload: {},
        ...asWorker({
          onExecutionCreated: async (id: string) => {
            reported.push(id);
          },
        }),
      }),
    ).rejects.toThrow("failed after the row existed");

    const created = await prisma.execution.findUniqueOrThrow({
      where: { inngestEventId: "job_attach_order" },
      select: { id: true },
    });
    expect(reported).toEqual([created.id]);
  });
});

describe("runExecution — the duplicate skip", () => {
  it("returns the original run without advancing the fan-out chain", async () => {
    // The comment this enforces is the only record of a real incident: a
    // duplicate is a re-send of a link the ORIGINAL run already owns, and that
    // original advances the chain itself. Advancing here too races a sibling
    // still running — the out-of-order dispatch chaining exists to prevent.
    const { workflowId, actionNodeId } = await buildWorkflow();

    const original = await prisma.execution.create({
      data: {
        workflowId,
        inngestEventId: "job_original",
        idempotencyKey: "fanout:exec_parent:item:3",
      },
      select: { id: true },
    });

    executors.set(NodeType.GOOGLE_SHEETS_ACTION, () => {
      throw new Error("the engine must not run for a duplicate");
    });

    const result = await runExecution({
      workflowId,
      inngestEventId: "job_duplicate",
      payload: {
        idempotencyKey: "fanout:exec_parent:item:3",
        fanOutChain: {
          nodeId: actionNodeId,
          outputKey: "item",
          index: 3,
          total: 10,
          executionId: "exec_parent",
          onItemFailure: "continue",
        },
      },
      ...asWorker(),
    });

    expect(result).toEqual({
      skipped: true,
      reason: "duplicate",
      existingExecutionId: original.id,
    });
    // Nothing dispatched: item 4 is the original run's to send.
    expect(sentExecutions).toEqual([]);
    // And no second row for the same key.
    const executions = await prisma.execution.findMany({
      where: { workflowId },
    });
    expect(executions).toHaveLength(1);
  });
});

describe("runExecution — runtime parity", () => {
  it("produces identical rows under the worker step and a pass-through step", async () => {
    // §7.2's row-for-row comparison, automated. The two runtimes differ only in
    // how a step is memoized, so nothing a reader of the execution page can see
    // may differ — same statuses, same sequences, same recorded output.
    //
    // ONE workflow, run twice. Two workflows would give the two runs different
    // node ids, and node ids appear inside the recorded context as output keys —
    // so the comparison would be scrubbing away exactly the payload it exists to
    // compare.
    const { workflowId } = await buildWorkflow();

    executors.set(NodeType.GOOGLE_SHEETS_ACTION, async (params) => {
      const { step, context, outputKey } = params;
      const planned = (await step.run("plan", async () => ({
        row: 12,
      }))) as { row: number };
      await step.run("write", async () => ({ wrote: planned.row }));
      return { ...context, [outputKey]: { row: planned.row } };
    });

    const run = async (label: string, worker: boolean) => {
      const result = await runExecution({
        workflowId,
        inngestEventId: `evt_${label}`,
        payload: { initialData: { seed: "same for both" } },
        runStep: passthroughRunStep,
        engineStepFor: worker
          ? (executionId: string) => createWorkerStep({ executionId })
          : () => passthroughRunStep,
        publish,
      });

      if (result.skipped) throw new Error("unexpected skip");

      const execution = await prisma.execution.findUniqueOrThrow({
        where: { id: result.executionId },
        select: { status: true, input: true, output: true, error: true },
      });
      const nodes = await prisma.nodeExecution.findMany({
        where: { executionId: result.executionId },
        select: {
          nodeId: true,
          nodeType: true,
          nodeName: true,
          sequence: true,
          status: true,
          input: true,
          output: true,
          error: true,
        },
        orderBy: { sequence: "asc" },
      });

      return { execution, nodes, context: result.context };
    };

    const inngestShaped = await run("inngest", false);
    const workerShaped = await run("worker", true);

    expect(workerShaped).toEqual(inngestShaped);
    expect(workerShaped.nodes).toHaveLength(2);
  });
});
