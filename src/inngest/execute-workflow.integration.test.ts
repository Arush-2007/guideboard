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
} from "vitest";
import { ExecutionStatus, NodeType, type Prisma } from "@/generated/prisma";
import type { StepTools } from "@/features/executions/types";
import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { runWorkflowNodes } from "./run-workflow";
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
 * resolver (`!#...#!` / `{{...}}`). It's a `*.integration.test.ts`, so it runs
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
          field: "http_request_n_get.httpResponse.status",
          operator: "equals",
          value: "200",
          stopOnFail: true,
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
          // Mix of {{...}} and !#...#! to exercise both syntaxes of renderTemplate.
          body: '{"getStatus":{{http_request_n_get.httpResponse.status}},"lead":"!#lead.name#!","enrichedName":"!#http_request_n_get.httpResponse.data.name#!"}',
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
            "New lead !#lead.name#! enriched as !#http_request_n_get.httpResponse.data.name#! (HTTP !#http_request_n_get.httpResponse.status#!)",
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

    // Discord action rendered its !#...#! template against the threaded context.
    expect(output.discord_n_discord.messageContent).toBe(
      "New lead Ada Lovelace enriched as Leanne Graham (HTTP 200)",
    );
  });

  it("stops the workflow when the condition fails (downstream nodes never run)", async () => {
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
          name: "Impossible gate",
          position: { x: 250, y: 0 },
          data: {
            field: "lead.tier",
            operator: "equals",
            value: "enterprise",
            stopOnFail: true,
          },
        },
        {
          id: "g_post",
          workflowId: workflow.id,
          type: NodeType.HTTP_REQUEST,
          name: "Should never run",
          position: { x: 500, y: 0 },
          data: { endpoint: `${baseUrl}/post`, method: "POST" },
        },
      ],
    });
    await prisma.connection.createMany({
      data: [
        {
          workflowId: workflow.id,
          fromNodeId: "g_trigger",
          toNodeId: "g_cond",
        },
        { workflowId: workflow.id, fromNodeId: "g_cond", toNodeId: "g_post" },
      ],
    });

    const loaded = await prisma.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
      include: { nodes: true, connections: true },
    });

    await expect(
      runWorkflowNodes({
        sortedNodes: topologicalSort(loaded.nodes, loaded.connections),
        userId,
        initialData: { lead: { name: "Ada", tier: "free" } },
        step,
        publish,
      }),
    ).rejects.toThrow(/condition not met/i);
  });
});
