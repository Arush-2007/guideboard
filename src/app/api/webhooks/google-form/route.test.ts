/**
 * The retired `POST /api/webhooks/google-form` endpoint.
 *
 * This file used to test the shared-secret auth that lived here. That auth is
 * gone — see `[token]/route.ts` — so what is worth pinning now is that the dead
 * URL behaves well toward the forms still posting to it: it must never run a
 * workflow, and it must say what to do instead of failing opaquely.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendWorkflowExecution, warn } = vi.hoisted(() => ({
  sendWorkflowExecution: vi.fn(async () => ({ ids: ["evt"] })),
  warn: vi.fn(),
}));

vi.mock("@/inngest/utils", () => ({ sendWorkflowExecution }));
vi.mock("@/lib/rate-limit", () => ({ isAllowed: () => true }));
vi.mock("@/lib/logger", () => ({ logger: { warn, error: vi.fn() } }));

import { POST } from "./route";

const call = (query = "?workflowId=wf_1") =>
  POST(
    new Request(`https://app.test/api/webhooks/google-form${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ responseId: "r1", responses: { Name: "Ada" } }),
    }) as never,
  );

beforeEach(() => {
  sendWorkflowExecution.mockClear();
  warn.mockClear();
});

describe("retired google-form webhook URL", () => {
  it("NEVER starts a workflow, whatever it is sent", async () => {
    await call();
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("answers 410 Gone, not 503", async () => {
    // 503 was the confusing symptom that sent an operator hunting for a missing
    // environment variable. The endpoint is retired, not misconfigured.
    const res = await call();
    expect(res.status).toBe(410);
  });

  it("tells the form owner to re-copy the Apps Script", async () => {
    const res = await call();
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Copy Apps Script"),
    });
  });

  it("logs the workflowId, so forms still on the old script are countable", async () => {
    await call("?workflowId=wf_legacy");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("retired URL"),
      expect.objectContaining({ workflowId: "wf_legacy" }),
    );
  });
});
