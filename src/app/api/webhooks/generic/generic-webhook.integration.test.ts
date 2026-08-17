import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Harness reaches `@/lib/auth` -> `@/lib/email` -> `server-only` (throws under
// vitest); stub auth/headers exactly like the other *.integration.test.ts files.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null } },
}));

// Dispatch is asserted, not performed — stub it (the rest of utils stays real).
const { sendWorkflowExecutionMock } = vi.hoisted(() => ({
  sendWorkflowExecutionMock: vi.fn(
    async (_input: {
      workflowId: string;
      initialData?: Record<string, unknown>;
      idempotencyKey?: string;
    }) => ({ ids: ["evt"] }),
  ),
}));
vi.mock("@/inngest/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/inngest/utils")>()),
  sendWorkflowExecution: sendWorkflowExecutionMock,
}));

// Identity encryption so the test needs no ENCRYPTION_KEY: the row stores the
// secret verbatim and the route's `decrypt` returns it unchanged.
vi.mock("@/lib/encryption", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));

import { NodeType } from "@/generated/prisma";
import prisma from "@/lib/db";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { POST } from "./[token]/route";

const SECRET = "test-secret";

let userId: string;
let workflowId: string;

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  userId = user.id;
  const workflow = await prisma.workflow.create({
    data: { name: "Webhook workflow", userId },
  });
  workflowId = workflow.id;
  sendWorkflowExecutionMock.mockClear();
});

afterEach(async () => {
  await cleanupDb();
});

// Each test uses a distinct token so the module-global in-memory rate limiter
// can't bleed counts across tests.
// `nodeType` is spelled out because the column has no default: a row must say
// which trigger it belongs to, or it is not insertable. That is deliberate —
// see the field's comment in schema.prisma.
const provisionWebhook = (token: string) =>
  prisma.webhookTrigger.create({
    data: {
      userId,
      workflowId,
      token,
      secret: SECRET,
      nodeType: NodeType.WEBHOOK_TRIGGER,
    },
  });

const call = (
  token: string,
  init: { body?: string; headers?: Record<string, string> } = {},
) => {
  const request = new NextRequest(
    `http://localhost/api/webhooks/generic/${token}`,
    { method: "POST", body: init.body, headers: init.headers },
  );
  return POST(request, { params: Promise.resolve({ token }) });
};

describe("generic webhook route", () => {
  it("dispatches a run with the JSON body as context and returns 202", async () => {
    await provisionWebhook("tok-ok");

    const res = await call("tok-ok", {
      body: JSON.stringify({ email: "ada@example.com" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(202);
    expect(sendWorkflowExecutionMock).toHaveBeenCalledTimes(1);
    const arg = sendWorkflowExecutionMock.mock.calls[0]?.[0];
    expect(arg?.workflowId).toBe(workflowId);
    expect(arg?.initialData).toMatchObject({
      webhook: { body: { email: "ada@example.com" } },
    });
    expect(arg?.idempotencyKey).toBeUndefined();
  });

  it("returns 404 and does not dispatch for an unknown token", async () => {
    const res = await call("does-not-exist", { body: "{}" });
    expect(res.status).toBe(404);
    expect(sendWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized payload with 413", async () => {
    await provisionWebhook("tok-big");
    const res = await call("tok-big", {
      body: "{}",
      headers: { "content-length": "2000000" },
    });
    expect(res.status).toBe(413);
    expect(sendWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid HMAC signature with 401", async () => {
    await provisionWebhook("tok-badsig");
    const res = await call("tok-badsig", {
      body: JSON.stringify({ a: 1 }),
      headers: { "x-guideboard-signature": "sha256=deadbeef" },
    });
    expect(res.status).toBe(401);
    expect(sendWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it("accepts a valid HMAC signature", async () => {
    await provisionWebhook("tok-goodsig");
    const body = JSON.stringify({ a: 1 });
    const signature =
      "sha256=" +
      createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

    const res = await call("tok-goodsig", {
      body,
      headers: { "x-guideboard-signature": signature },
    });

    expect(res.status).toBe(202);
    expect(sendWorkflowExecutionMock).toHaveBeenCalledTimes(1);
  });

  it("passes an Idempotency-Key header through to the dispatch", async () => {
    await provisionWebhook("tok-idem");
    await call("tok-idem", {
      body: "{}",
      headers: { "idempotency-key": "abc-123" },
    });
    expect(sendWorkflowExecutionMock.mock.calls[0]?.[0]?.idempotencyKey).toBe(
      "abc-123",
    );
  });

  it("rate-limits a token after 100 requests in the window", async () => {
    await provisionWebhook("tok-rl");
    let lastStatus = 0;
    for (let i = 0; i < 101; i++) {
      const res = await call("tok-rl", { body: "{}" });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
