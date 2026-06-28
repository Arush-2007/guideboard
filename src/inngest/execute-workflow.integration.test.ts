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

import type { StepTools } from "@/features/executions/types";
import { ExecutionStatus, NodeType, type Prisma } from "@/generated/prisma";
import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { type NodeRecorder, runWorkflowNodes } from "./run-workflow";
import { topologicalSort } from "./utils";

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
      initialData: { lead: { name: "Ada", tier: "free" } },
      step,
      publish,
      recorder: {
        async record({ nodeId, status }) {
          statuses[nodeId] = status;
        },
      },
    });

    // The run completes (no throw): the gate evaluated false and routed to its
    // unconnected branch, so the downstream POST is skipped, not failed.
    expect(statuses.g_cond).toBe("SUCCESS");
    expect(statuses.g_post).toBe("SKIPPED");
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
    async record({ nodeId, status, output }) {
      captured.order.push(nodeId);
      captured.statuses[nodeId] = status;
      if (output !== undefined) captured.outputs[nodeId] = output;
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

    // REGRESSION GUARD: the condition routed (true) but added no context key, so
    // its recorded output must be empty. `newKeysDiff` keys off property
    // presence; a reference diff would wrongly capture the whole context here.
    expect(captured.outputs.r_cond).toEqual({});
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
        { workflowId: workflow.id, fromNodeId: "f_trigger", toNodeId: "f_cond" },
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
