/**
 * Google Form trigger, end to end against a real Postgres.
 *
 * The unit suite mocks the database, so it can only prove the route behaves
 * given a row. This proves the chain that actually broke in production:
 *
 *     save the workflow  ->  a token row is provisioned
 *     copy the script    ->  it is built from THAT row's token + secret
 *     submit the form    ->  the script's request is accepted and dispatches
 *
 * Every link is real here except Google (the script runs against Apps Script
 * shims) and Inngest (dispatch is asserted, not performed). The old code failed
 * at link two — nothing provisioned a credential and the script sent none — and
 * no test in the suite crossed those boundaries together, which is why a fully
 * broken trigger shipped green.
 */

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null } },
}));

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

// Identity encryption so the test needs no ENCRYPTION_KEY.
vi.mock("@/lib/encryption", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));

import { generateGoogleFormScript } from "@/features/triggers/components/google-form-trigger/utils";
import { NodeType } from "@/generated/prisma";
import prisma from "@/lib/db";
import { syncTriggerPollsForWorkflow } from "@/lib/workflow-persistence";
import { cleanupDb, createTestUser } from "@/test/trpc-harness";
import { POST } from "./[token]/route";

let userId: string;
let workflowId: string;

beforeEach(async () => {
  await cleanupDb();
  const user = await createTestUser();
  userId = user.id;
  const workflow = await prisma.workflow.create({
    data: { name: "Mahindra form workflow", userId },
  });
  workflowId = workflow.id;
  sendWorkflowExecutionMock.mockClear();
});

afterEach(async () => {
  await cleanupDb();
});

/** Saving a workflow that holds the node — what the editor does. */
const saveWorkflowWithGoogleForm = () =>
  syncTriggerPollsForWorkflow(userId, workflowId, [
    { type: NodeType.GOOGLE_FORM_TRIGGER, data: {} },
  ]);

/** Runs the generated script under Apps Script shims; returns its HTTP call. */
function submitForm(script: string, answers: Record<string, string>) {
  let captured!: { url: string; options: Record<string, string> };

  const Utilities = {
    computeHmacSha256Signature: (value: string, key: string) =>
      Array.from(createHmac("sha256", key).update(value, "utf8").digest()).map(
        (b) => (b > 127 ? b - 256 : b),
      ),
  };
  const UrlFetchApp = {
    fetch: (url: string, options: Record<string, string>) => {
      captured = { url, options };
      return { getResponseCode: () => 200, getContentText: () => "{}" };
    },
  };

  const event = {
    response: {
      getItemResponses: () =>
        Object.entries(answers).map(([title, value]) => ({
          getItem: () => ({ getTitle: () => title }),
          getResponse: () => value,
        })),
      getId: () => "resp_live_1",
      getTimestamp: () => "2026-08-06T00:00:00.000Z",
      getRespondentEmail: () => "client@example.com",
    },
    source: { getId: () => "form_1", getTitle: () => "Mahindra Form" },
  };

  const load = new Function(
    "Utilities",
    "UrlFetchApp",
    `${script}\nreturn { onFormSubmit: onFormSubmit };`,
  );
  load(Utilities, UrlFetchApp).onFormSubmit(event);

  return captured;
}

const deliver = (call: { url: string; options: Record<string, string> }) => {
  const token = call.url.split("/").pop() as string;
  return POST(
    new NextRequest(call.url, {
      method: "POST",
      body: call.options.payload,
      headers: {
        "content-type": "application/json",
        ...(call.options.headers as unknown as Record<string, string>),
      },
    }),
    { params: Promise.resolve({ token }) },
  );
};

describe("google form trigger, save -> copy script -> submit", () => {
  it("dispatches the run", async () => {
    await saveWorkflowWithGoogleForm();

    const row = await prisma.webhookTrigger.findFirst({
      where: { workflowId, nodeType: NodeType.GOOGLE_FORM_TRIGGER },
    });
    expect(row).not.toBeNull();

    const script = generateGoogleFormScript(
      `http://localhost/api/webhooks/google-form/${row?.token}`,
      row?.secret as string,
    );

    const res = await deliver(submitForm(script, { Name: "Ada", Qty: "3" }));

    expect(res.status).toBe(200);
    expect(sendWorkflowExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId,
        initialData: {
          googleForm: expect.objectContaining({
            formId: "form_1",
            responseId: "resp_live_1",
            respondentEmail: "client@example.com",
            responses: { Name: "Ada", Qty: "3" },
          }),
        },
        idempotencyKey: "google-form:resp_live_1",
      }),
    );
  });

  it("provisions a signed-by-default row, so knowing the URL is not enough", async () => {
    await saveWorkflowWithGoogleForm();
    const row = await prisma.webhookTrigger.findFirst({
      where: { workflowId, nodeType: NodeType.GOOGLE_FORM_TRIGGER },
    });

    expect(row?.requireSignature).toBe(true);

    // Same body, no signature — refused.
    const res = await POST(
      new NextRequest(
        `http://localhost/api/webhooks/google-form/${row?.token}`,
        {
          method: "POST",
          body: JSON.stringify({ responseId: "r", responses: {} }),
          headers: { "content-type": "application/json" },
        },
      ),
      { params: Promise.resolve({ token: row?.token as string }) },
    );

    expect(res.status).toBe(401);
    expect(sendWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it("keeps the URL STABLE across re-saves, so a connected form keeps working", async () => {
    await saveWorkflowWithGoogleForm();
    const first = await prisma.webhookTrigger.findFirst({
      where: { workflowId, nodeType: NodeType.GOOGLE_FORM_TRIGGER },
    });

    await saveWorkflowWithGoogleForm();
    const second = await prisma.webhookTrigger.findFirst({
      where: { workflowId, nodeType: NodeType.GOOGLE_FORM_TRIGGER },
    });

    expect(second?.token).toBe(first?.token);
    expect(second?.secret).toBe(first?.secret);
  });

  it("does not disturb a generic webhook on the same workflow", async () => {
    // The composite key exists for this: before it, one workflow could hold only
    // one row, and the provisioning loop's delete branch was scoped by workflow
    // alone — so saving would have destroyed the other trigger's credentials.
    await syncTriggerPollsForWorkflow(userId, workflowId, [
      { type: NodeType.GOOGLE_FORM_TRIGGER, data: {} },
      { type: NodeType.WEBHOOK_TRIGGER, data: {} },
    ]);

    const rows = await prisma.webhookTrigger.findMany({
      where: { workflowId },
      orderBy: { nodeType: "asc" },
    });

    expect(rows.map((r) => r.nodeType)).toEqual([
      NodeType.GOOGLE_FORM_TRIGGER,
      NodeType.WEBHOOK_TRIGGER,
    ]);
    // Distinct credentials, so neither endpoint accepts the other's token.
    expect(rows[0].token).not.toBe(rows[1].token);
  });

  it("removes the credentials when the node is removed", async () => {
    await saveWorkflowWithGoogleForm();
    await syncTriggerPollsForWorkflow(userId, workflowId, []);

    const row = await prisma.webhookTrigger.findFirst({
      where: { workflowId, nodeType: NodeType.GOOGLE_FORM_TRIGGER },
    });
    expect(row).toBeNull();
  });
});
