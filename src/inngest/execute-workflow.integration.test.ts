import { createServer, type Server } from "node:http";
import type { Realtime } from "@inngest/realtime";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The harness statically imports `appRouter`, whose graph reaches
// `@/lib/auth` -> `@/lib/email` -> `import "server-only"`, which throws under
// vitest. This file never exercises auth (it drives the engine directly), so we
// stub auth out exactly like the other *.integration.test.ts files do.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => null,
    },
  },
}));

import { createPrismaNodeRecorder } from "@/execution/node-recorder";
import { passthroughRunStep, runExecution } from "@/execution/run-execution";
import { topologicalSort } from "@/execution/topological-sort";
import type { StepTools } from "@/features/executions/types";
import { ExecutionStatus, NodeType, type Prisma } from "@/generated/prisma";
import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { createWorkerStep } from "@/worker/worker-step";
import { type NodeRecorder, runWorkflowNodes } from "./run-workflow";

/**
 * End-to-end engine test: builds a real 5-node workflow in Postgres and runs it
 * through the SAME `topologicalSort` + `runWorkflowNodes` path that
 * `executeWorkflow` uses in production, then persists and asserts the resulting
 * `Execution` row.
 *
 * The HTTP/Discord nodes make real outbound calls, but against a LOCAL throwaway
 * server (not a public echo service) so the test is hermetic and deterministic.
 * It proves the nodes execute and thread context end to end — trigger -> GET ->
 * condition gate -> templated POST -> action — including the `renderTemplate`
 * resolver (`@<...>@` / `{{...}}`). It's a `*.integration.test.ts`, so it runs
 * only under the integration config (`npm run test:integration`).
 */

// Inngest's `step.run(name, fn)` checkpoints work; for a single in-process run
// it's just "invoke fn". `publish` streams UI status — a no-op here.
const step = {
  run: async (_name: string, fn: () => unknown) => fn(),
} as unknown as StepTools;

const publish = (async () => {}) as unknown as Realtime.PublishFn;

let userId: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // GET /users/1 -> a fixed user; POST /post -> echoes the parsed JSON back
  // under `.json` (mirroring httpbin's shape so the assertions read naturally).
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/users/1")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 1, name: "Leanne Graham" }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/post")) {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        let parsed: unknown = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          parsed = null;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ json: parsed }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  userId = user.id;
});

afterEach(async () => {
  await cleanupDb();
});

describe("executeWorkflow engine (5-node workflow)", () => {
  it("runs trigger -> GET -> condition -> templated POST -> action and threads context end to end", async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Lead enrichment ping", userId },
    });

    // 1) Manual trigger  2) HTTP GET  3) Condition gate
    // 4) HTTP POST (templated from upstream)  5) Discord action
    const nodes = [
      {
        id: "n_trigger",
        type: NodeType.MANUAL_TRIGGER,
        name: "Manual trigger",
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: "n_get",
        type: NodeType.HTTP_REQUEST,
        name: "Fetch user",
        position: { x: 250, y: 0 },
        data: { endpoint: `${baseUrl}/users/1`, method: "GET" },
      },
      {
        id: "n_cond",
        type: NodeType.CONDITION,
        name: "Only if HTTP 200",
        position: { x: 500, y: 0 },
        data: {
          field: "@<http_request_n_get.httpResponse.status>@",
          operator: "equals",
          value: "200",
        },
      },
      {
        id: "n_post",
        type: NodeType.HTTP_REQUEST,
        name: "Forward enriched lead",
        position: { x: 750, y: 0 },
        data: {
          endpoint: `${baseUrl}/post`,
          method: "POST",
          // Mix of {{...}} and @<...>@ to exercise both syntaxes of renderTemplate.
          body: '{"getStatus":{{http_request_n_get.httpResponse.status}},"lead":"@<lead.name>@","enrichedName":"@<http_request_n_get.httpResponse.data.name>@"}',
        },
      },
      {
        id: "n_discord",
        type: NodeType.DISCORD,
        name: "Notify",
        position: { x: 1000, y: 0 },
        data: {
          webhookUrl: `${baseUrl}/post`,
          content:
            "New lead @<lead.name>@ enriched as @<http_request_n_get.httpResponse.data.name>@ (HTTP @<http_request_n_get.httpResponse.status>@)",
        },
      },
    ];

    await prisma.node.createMany({
      data: nodes.map((n) => ({
        id: n.id,
        workflowId: workflow.id,
        type: n.type,
        name: n.name,
        position: n.position,
        data: n.data,
      })),
    });

    const edges: [string, string][] = [
      ["n_trigger", "n_get"],
      ["n_get", "n_cond"],
      ["n_cond", "n_post"],
      ["n_post", "n_discord"],
    ];
    await prisma.connection.createMany({
      data: edges.map(([from, to]) => ({
        workflowId: workflow.id,
        fromNodeId: from,
        toNodeId: to,
      })),
    });

    // --- mirror executeWorkflow's bookkeeping around the shared engine core ---
    const inngestEventId = `test-${workflow.id}`;
    await prisma.execution.create({
      data: { workflowId: workflow.id, inngestEventId },
    });

    const loaded = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
      include: { nodes: true, connections: true },
    });

    const context = await runWorkflowNodes({
      sortedNodes: topologicalSort(loaded.nodes, loaded.connections),
      connections: loaded.connections,
      userId,
      executionId: "exec_test",
      initialData: { lead: { name: "Ada Lovelace", email: "ada@example.com" } },
      step,
      publish,
    });

    await prisma.execution.update({
      where: { inngestEventId, workflowId: workflow.id },
      data: {
        status: ExecutionStatus.SUCCESS,
        completedAt: new Date(),
        output: context as Prisma.InputJsonObject,
      },
    });

    // --- assert the persisted result, read back from Postgres ---
    const execution = await prisma.execution.findFirstOrThrow({
      where: { workflowId: workflow.id },
    });
    expect(execution.status).toBe(ExecutionStatus.SUCCESS);

    const output = execution.output as Record<string, any>;

    // GET node fetched data and stored it under its output key.
    expect(output.http_request_n_get.httpResponse.status).toBe(200);
    expect(output.http_request_n_get.httpResponse.data.name).toBe(
      "Leanne Graham",
    );

    // POST node templated a body from BOTH the trigger context and the GET
    // output (via renderTemplate); the echo server returns it under `.json`.
    const echoed = output.http_request_n_post.httpResponse.data.json;
    expect(echoed).toEqual({
      lead: "Ada Lovelace",
      enrichedName: "Leanne Graham",
      getStatus: 200,
    });

    // Discord action rendered its @<...>@ template against the threaded context.
    expect(output.discord_n_discord.messageContent).toBe(
      "New lead Ada Lovelace enriched as Leanne Graham (HTTP 200)",
    );
  });

  it("routes to the false branch and skips downstream when the condition fails", async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Gated workflow", userId },
    });

    await prisma.node.createMany({
      data: [
        {
          id: "g_trigger",
          workflowId: workflow.id,
          type: NodeType.MANUAL_TRIGGER,
          name: "Manual trigger",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "g_cond",
          workflowId: workflow.id,
          type: NodeType.CONDITION,
          name: "Tier gate",
          position: { x: 250, y: 0 },
          data: {
            field: "@<lead.tier>@",
            operator: "equals",
            value: "enterprise",
          },
        },
        {
          id: "g_post",
          workflowId: workflow.id,
          type: NodeType.HTTP_REQUEST,
          name: "Only on the true branch",
          position: { x: 500, y: 0 },
          data: { endpoint: `${baseUrl}/post`, method: "POST" },
        },
      ],
    });
    // g_post hangs off the condition's `true` output, so a failed (false)
    // condition leaves it unreachable.
    await prisma.connection.createMany({
      data: [
        {
          workflowId: workflow.id,
          fromNodeId: "g_trigger",
          toNodeId: "g_cond",
        },
        {
          workflowId: workflow.id,
          fromNodeId: "g_cond",
          toNodeId: "g_post",
          fromOutput: "true",
        },
      ],
    });

    const loaded = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
      include: { nodes: true, connections: true },
    });

    const statuses: Record<string, string> = {};
    await runWorkflowNodes({
      sortedNodes: topologicalSort(loaded.nodes, loaded.connections),
      connections: loaded.connections,
      userId,
      executionId: "exec_test",
      initialData: { lead: { name: "Ada", tier: "free" } },
      step,
      publish,
      recorder: {
        async flush(records) {
          for (const { nodeId, status } of records) statuses[nodeId] = status;
        },
      },
    });

    // The run completes (no throw): the gate evaluated false and routed to its
    // unconnected branch, so the downstream POST is skipped, not failed.
    expect(statuses.g_cond).toBe("SUCCESS");
    expect(statuses.g_post).toBe("SKIPPED");
  });
});

describe("runWorkflowNodes replay-from-node", () => {
  it("seeds the chosen node's recorded input, skips upstream, and runs it + descendants", async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Replay workflow", userId },
    });

    // trigger -> GET -> condition -> POST. Replaying from the condition should
    // skip the trigger + GET (already ran) and re-run condition + POST against
    // the seeded snapshot — without re-fetching from the GET node.
    await prisma.node.createMany({
      data: [
        {
          id: "rp_trigger",
          workflowId: workflow.id,
          type: NodeType.MANUAL_TRIGGER,
          name: "Manual trigger",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "rp_get",
          workflowId: workflow.id,
          type: NodeType.HTTP_REQUEST,
          name: "Fetch user",
          position: { x: 250, y: 0 },
          data: { endpoint: `${baseUrl}/users/1`, method: "GET" },
        },
        {
          id: "rp_cond",
          workflowId: workflow.id,
          type: NodeType.CONDITION,
          name: "Only if HTTP 200",
          position: { x: 500, y: 0 },
          data: {
            field: "@<http_request_rp_get.httpResponse.status>@",
            operator: "equals",
            value: "200",
          },
        },
        {
          id: "rp_post",
          workflowId: workflow.id,
          type: NodeType.HTTP_REQUEST,
          name: "Forward lead",
          position: { x: 750, y: 0 },
          data: {
            endpoint: `${baseUrl}/post`,
            method: "POST",
            body: '{"enrichedName":"@<http_request_rp_get.httpResponse.data.name>@"}',
          },
        },
      ],
    });
    await prisma.connection.createMany({
      data: [
        {
          workflowId: workflow.id,
          fromNodeId: "rp_trigger",
          toNodeId: "rp_get",
        },
        { workflowId: workflow.id, fromNodeId: "rp_get", toNodeId: "rp_cond" },
        { workflowId: workflow.id, fromNodeId: "rp_cond", toNodeId: "rp_post" },
      ],
    });

    const loaded = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
      include: { nodes: true, connections: true },
    });
    const sortedNodes = topologicalSort(loaded.nodes, loaded.connections);

    // --- first run: capture the exact context that entered each node ---
    const capturedInputs: Record<string, unknown> = {};
    await runWorkflowNodes({
      sortedNodes,
      connections: loaded.connections,
      userId,
      executionId: "exec_test",
      initialData: { lead: { name: "Ada" } },
      step,
      publish,
      recorder: {
        async flush(records) {
          for (const { nodeId, input } of records)
            capturedInputs[nodeId] = input;
        },
      },
    });

    // The condition's recorded input includes the GET output, so a replay seeded
    // with it can evaluate the gate and template the POST without re-fetching.
    const condSnapshot = capturedInputs.rp_cond as Record<string, unknown>;
    expect(condSnapshot).toHaveProperty("http_request_rp_get");

    // --- replay from the condition node ---
    const replayStatuses: Record<string, string> = {};
    const replayContext = await runWorkflowNodes({
      sortedNodes,
      connections: loaded.connections,
      userId,
      executionId: "exec_test",
      initialData: condSnapshot,
      replayFromNodeId: "rp_cond",
      step,
      publish,
      recorder: {
        async flush(records) {
          for (const { nodeId, status } of records)
            replayStatuses[nodeId] = status;
        },
      },
    });

    // Upstream nodes are treated as already-run (skipped); the chosen node and
    // its descendant re-run fresh.
    expect(replayStatuses.rp_trigger).toBe("SKIPPED");
    expect(replayStatuses.rp_get).toBe("SKIPPED");
    expect(replayStatuses.rp_cond).toBe("SUCCESS");
    expect(replayStatuses.rp_post).toBe("SUCCESS");

    // The POST templated its body from the SEEDED GET output (proving the snapshot
    // carried forward), and the seeded key is still present in the final context.
    const ctx = replayContext as Record<string, any>;
    expect(ctx.http_request_rp_get.httpResponse.data.name).toBe(
      "Leanne Graham",
    );
    expect(ctx.http_request_rp_post.httpResponse.data.json).toEqual({
      enrichedName: "Leanne Graham",
    });
  });
});

describe("runWorkflowNodes recorder (per-node observability)", () => {
  // Faithful step shim: Inngest serializes every `step.run` output, so any node
  // whose output is threaded back through a step yields a deep copy with
  // all-new references. `newKeysDiff` must key off property presence, not
  // reference identity; serializing here keeps the test honest about that.
  const serializingStep = {
    run: async (_name: string, fn: () => unknown) =>
      JSON.parse(JSON.stringify((await fn()) ?? null)),
  } as unknown as StepTools;

  type Captured = {
    order: string[];
    statuses: Record<string, string>;
    outputs: Record<string, unknown>;
  };

  const makeRecorder = (captured: Captured): NodeRecorder => ({
    async flush(records) {
      for (const { nodeId, status, output } of records) {
        captured.order.push(nodeId);
        captured.statuses[nodeId] = status;
        if (output !== undefined) captured.outputs[nodeId] = output;
      }
    },
  });

  const buildWorkflow = async (conditionValue: string) => {
    const workflow = await prisma.workflow.create({
      data: { name: "Recorder workflow", userId },
    });
    await prisma.node.createMany({
      data: [
        {
          id: "r_trigger",
          workflowId: workflow.id,
          type: NodeType.MANUAL_TRIGGER,
          name: "Manual trigger",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "r_get",
          workflowId: workflow.id,
          type: NodeType.HTTP_REQUEST,
          name: "Fetch user",
          position: { x: 250, y: 0 },
          data: { endpoint: `${baseUrl}/users/1`, method: "GET" },
        },
        {
          id: "r_cond",
          workflowId: workflow.id,
          type: NodeType.CONDITION,
          name: "Only if HTTP 200",
          position: { x: 500, y: 0 },
          data: {
            field: "@<http_request_r_get.httpResponse.status>@",
            operator: "equals",
            value: conditionValue,
          },
        },
      ],
    });
    await prisma.connection.createMany({
      data: [
        { workflowId: workflow.id, fromNodeId: "r_trigger", toNodeId: "r_get" },
        { workflowId: workflow.id, fromNodeId: "r_get", toNodeId: "r_cond" },
      ],
    });
    return prisma.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
      include: { nodes: true, connections: true },
    });
  };

  it("records new-keys-only output — condition node (adds nothing) is empty", async () => {
    const loaded = await buildWorkflow("200"); // passes
    const captured: Captured = { order: [], statuses: {}, outputs: {} };

    await runWorkflowNodes({
      sortedNodes: topologicalSort(loaded.nodes, loaded.connections),
      connections: loaded.connections,
      userId,
      executionId: "exec_test",
      initialData: { lead: { name: "Ada" } },
      step: serializingStep,
      publish,
      recorder: makeRecorder(captured),
    });

    // One record per node, in order, all successful.
    expect(captured.order).toEqual(["r_trigger", "r_get", "r_cond"]);
    expect(captured.statuses.r_cond).toBe("SUCCESS");

    // The HTTP node contributed exactly its namespaced output key.
    expect(Object.keys(captured.outputs.r_get as object)).toEqual([
      "http_request_r_get",
    ]);

    // REGRESSION GUARD: the condition routed (true) and contributes exactly its
    // own namespaced result key — nothing else from the threaded context.
    // `newKeysDiff` keys off property presence; a reference diff would wrongly
    // capture the whole context here.
    expect(captured.outputs.r_cond).toEqual({
      condition_r_cond: { result: true },
    });
  });

  it("records a FAILED node (with no output) when it throws", async () => {
    // A condition with no `operator` fails schema validation inside the executor,
    // which throws — exercising the engine's per-node FAILED recording path now
    // that a merely-unmet condition routes (false) instead of throwing.
    const workflow = await prisma.workflow.create({
      data: { name: "Failing node workflow", userId },
    });
    await prisma.node.createMany({
      data: [
        {
          id: "f_trigger",
          workflowId: workflow.id,
          type: NodeType.MANUAL_TRIGGER,
          name: "Manual trigger",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "f_cond",
          workflowId: workflow.id,
          type: NodeType.CONDITION,
          name: "Misconfigured gate",
          position: { x: 250, y: 0 },
          // Missing `operator` -> parseNodeConfig rejects -> executor throws.
          data: { field: "@<lead.name>@", value: "x" },
        },
      ],
    });
    await prisma.connection.createMany({
      data: [
        {
          workflowId: workflow.id,
          fromNodeId: "f_trigger",
          toNodeId: "f_cond",
        },
      ],
    });
    const loaded = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
      include: { nodes: true, connections: true },
    });
    const captured: Captured = { order: [], statuses: {}, outputs: {} };

    await expect(
      runWorkflowNodes({
        sortedNodes: topologicalSort(loaded.nodes, loaded.connections),
        connections: loaded.connections,
        userId,
        executionId: "exec_test",
        initialData: { lead: { name: "Ada" } },
        step: serializingStep,
        publish,
        recorder: makeRecorder(captured),
      }),
    ).rejects.toThrow(/operator/i);

    expect(captured.statuses.f_cond).toBe("FAILED");
    expect(captured.outputs.f_cond).toBeUndefined();
  });
});

describe("execution idempotency scoping", () => {
  /**
   * The dedup rule lives in the `@@unique([workflowId, idempotencyKey])`
   * constraint, so it is asserted against a real Postgres rather than against a
   * key-building helper. `executeWorkflow`'s `check-idempotency` step reads
   * through this same pair.
   */
  const execution = (workflowId: string, idempotencyKey: string) => ({
    workflowId,
    idempotencyKey,
    inngestEventId: `evt_${Math.random().toString(36).slice(2)}`,
  });

  it("lets two workflows handle the same external event", async () => {
    // The shape that broke a copied workflow: both poll the same sheet row, so
    // both mint the SAME event key. Under a global unique the second insert
    // failed and that workflow silently never ran.
    const original = await prisma.workflow.create({
      data: { name: "Original", userId },
    });
    const copy = await prisma.workflow.create({
      data: { name: "Original.2", userId },
    });
    const eventKey = "google_sheets:sheet-1:7:added";

    await prisma.execution.create({ data: execution(original.id, eventKey) });
    await prisma.execution.create({ data: execution(copy.id, eventKey) });

    expect(
      await prisma.execution.count({ where: { idempotencyKey: eventKey } }),
    ).toBe(2);
  });

  it("still rejects a repeat of the same event within one workflow", async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Solo", userId },
    });
    const eventKey = "gmail:msg_9";

    await prisma.execution.create({ data: execution(workflow.id, eventKey) });

    await expect(
      prisma.execution.create({ data: execution(workflow.id, eventKey) }),
    ).rejects.toThrow();
  });

  it("keeps letting through the many runs that carry no key", async () => {
    // Postgres treats NULLs as distinct, so an unkeyed run is never a duplicate.
    const workflow = await prisma.workflow.create({
      data: { name: "Manual", userId },
    });

    await prisma.execution.create({
      data: { workflowId: workflow.id, inngestEventId: "evt_a" },
    });
    await prisma.execution.create({
      data: { workflowId: workflow.id, inngestEventId: "evt_b" },
    });

    expect(
      await prisma.execution.count({ where: { workflowId: workflow.id } }),
    ).toBe(2);
  });
});

/**
 * Runtime parity over REAL executors.
 *
 * The sibling test in `src/execution/run-execution.integration.test.ts` proves
 * the same property against fake executors; this one is the harder half, and the
 * difference is what makes it worth having: `createWorkerStep` round-trips every
 * step's value through `jsonb`, and here those values are real HTTP responses
 * rather than hand-written literals. If that round trip changed the shape of
 * anything a downstream node's template reads, the rendered Discord string would
 * differ between the two runs.
 *
 * Both runs go through `runExecution` — the whole body, idempotency check and
 * `update-execution` included — rather than a hand-assembled pipeline, so the
 * comparison covers what production actually executes.
 *
 * ONE workflow, run twice. Two workflows would give the runs different node ids,
 * and node ids ARE the context's output keys — so the comparison would be
 * normalising away exactly the payload it exists to compare.
 */
describe("runtime parity — real executors under the worker's step", () => {
  it("produces the same context and rows under both step implementations", async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Parity fixture", userId },
    });

    await prisma.node.createMany({
      data: [
        {
          id: "p_trigger",
          workflowId: workflow.id,
          type: NodeType.MANUAL_TRIGGER,
          name: "Manual trigger",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "p_get",
          workflowId: workflow.id,
          type: NodeType.HTTP_REQUEST,
          name: "Fetch user",
          position: { x: 250, y: 0 },
          data: { endpoint: `${baseUrl}/users/1`, method: "GET" },
        },
        {
          id: "p_discord",
          workflowId: workflow.id,
          type: NodeType.DISCORD,
          name: "Notify",
          position: { x: 500, y: 0 },
          data: {
            webhookUrl: `${baseUrl}/post`,
            content:
              "Enriched as @<http_request_p_get.httpResponse.data.name>@ (HTTP @<http_request_p_get.httpResponse.status>@)",
          },
        },
      ],
    });
    await prisma.connection.createMany({
      data: [
        {
          workflowId: workflow.id,
          fromNodeId: "p_trigger",
          toNodeId: "p_get",
        },
        {
          workflowId: workflow.id,
          fromNodeId: "p_get",
          toNodeId: "p_discord",
        },
      ],
    });

    const run = async (label: string, worker: boolean) => {
      const result = await runExecution({
        workflowId: workflow.id,
        inngestEventId: `evt_parity_${label}`,
        payload: { initialData: { lead: { name: "Ada Lovelace" } } },
        runStep: passthroughRunStep,
        engineStepFor: worker
          ? (executionId: string) => createWorkerStep({ executionId })
          : () => passthroughRunStep,
        publish,
      });

      if (result.skipped) throw new Error("unexpected skip");

      const execution = await prisma.execution.findUniqueOrThrow({
        where: { id: result.executionId },
        select: { status: true, output: true, error: true },
      });
      const nodes = await prisma.nodeExecution.findMany({
        where: { executionId: result.executionId },
        select: {
          nodeId: true,
          nodeType: true,
          sequence: true,
          status: true,
          output: true,
        },
        orderBy: { sequence: "asc" },
      });

      return { execution, nodes, context: result.context };
    };

    const shimmed = await run("shim", false);
    const durable = await run("worker", true);

    expect(durable).toEqual(shimmed);

    // Not just equal to each other — equal to the RIGHT thing. Two identically
    // broken runs would satisfy the comparison above on its own.
    expect(
      (durable.context.discord_p_discord as { messageContent: string })
        .messageContent,
    ).toBe("Enriched as Leanne Graham (HTTP 200)");
    expect(durable.execution.status).toBe(ExecutionStatus.SUCCESS);
    expect(durable.nodes).toHaveLength(3);
  });
});

describe("createPrismaNodeRecorder — what a SKIPPED row stores", () => {
  /**
   * A settled-node record as the ENGINE hands one to the recorder — which is
   * why a SKIPPED record carries no `input` at all. See `NodeRecord.input`: a
   * node that never ran received nothing, and what flowed past it is not its
   * input. Constructing one WITH an input here would test a shape the engine
   * cannot produce.
   */
  const record = (
    nodeId: string,
    status: "SUCCESS" | "SKIPPED",
    input: Record<string, unknown>,
  ) => ({
    nodeId,
    nodeType: NodeType.HTTP_REQUEST,
    nodeName: nodeId,
    sequence: 1,
    status,
    ...(status === "SKIPPED" ? {} : { input }),
    durationMs: 0,
    completedAt: new Date(),
  });

  const newExecution = async () => {
    const workflow = await prisma.workflow.create({
      data: { name: "Recorder rows", userId },
    });
    const execution = await prisma.execution.create({
      data: {
        workflowId: workflow.id,
        inngestEventId: `evt_${Math.random()}`,
      },
    });
    return execution.id;
  };

  // The context that flows PAST a skipped node — big, and read by nothing.
  const context = {
    OG_SHEETS: { rows: Array.from({ length: 200 }, (_, i) => i) },
  };

  it("stores no input for a skipped node, and the real input for one that ran", async () => {
    const executionId = await newExecution();

    await createPrismaNodeRecorder({ executionId }).flush([
      record("ran", "SUCCESS", context),
      record("skipped", "SKIPPED", context),
    ] as never);

    const rows = await prisma.nodeExecution.findMany({
      where: { executionId },
      select: { nodeId: true, status: true, input: true },
      orderBy: { nodeId: "asc" },
    });

    const ran = rows.find((r) => r.nodeId === "ran");
    const skipped = rows.find((r) => r.nodeId === "skipped");

    // The row still exists — it is what tells "deliberately not run" apart from
    // "never reached", and the skipped panel and replay refusal both need it.
    expect(skipped?.status).toBe("SKIPPED");
    // …but carries none of the context that merely flowed past it.
    expect(skipped?.input).toBeNull();

    // A node that actually ran is unaffected.
    expect(ran?.input).toEqual(context);
  });

  it("keeps the skipped row cheap regardless of how large the context is", async () => {
    const executionId = await newExecution();
    const huge = { blob: "x".repeat(500_000) };

    await createPrismaNodeRecorder({ executionId }).flush([
      record("skipped", "SKIPPED", huge),
    ] as never);

    const row = await prisma.nodeExecution.findFirstOrThrow({
      where: { executionId },
      select: { input: true },
    });
    // Not a truncation marker either — nothing is stored at all, so there is
    // no serialization of the context on the run's critical path.
    expect(row.input).toBeNull();
  });
});
