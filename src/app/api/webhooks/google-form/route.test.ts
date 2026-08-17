/**
 * The retired `POST /api/webhooks/google-form` endpoint.
 *
 * This file used to test the shared-secret auth that lived here. That auth is
 * gone — see `[token]/route.ts` — so what is worth pinning now is that the dead
 * URL behaves well toward the forms still posting to it: it must never run a
 * workflow, it must stay observable, and it must not depend on anything that can
 * fail in order to answer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendWorkflowExecution, isAllowed, warn, error } = vi.hoisted(() => ({
  sendWorkflowExecution: vi.fn(async () => ({ ids: ["evt"] })),
  isAllowed: vi.fn(() => true),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/inngest/utils", () => ({ sendWorkflowExecution }));
vi.mock("@/lib/rate-limit", () => ({ isAllowed }));
vi.mock("@/lib/logger", () => ({ logger: { warn, error } }));

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
  error.mockClear();
  isAllowed.mockClear();
  isAllowed.mockReturnValue(true);
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

  it("leads with the instruction, because Apps Script truncates the rest", async () => {
    // The old script surfaces this body only inside a truncated exception
    // string, so an actionable first sentence is the whole delivery budget.
    const { error: message } = (await (await call()).json()) as {
      error: string;
    };
    expect(message.slice(0, 100)).toContain("Re-copy the Apps Script");
  });

  it("points at the ⋮ menu, which is where Forms actually keeps Apps Script", async () => {
    // Forms has no Extensions menu — that is Sheets and Docs. Sending a stuck
    // owner to a menu they cannot find wastes the one message that reaches them.
    const { error: message } = (await (await call()).json()) as {
      error: string;
    };
    expect(message).not.toContain("Extensions");
    expect(message).toContain("⋮ menu");
  });

  it("logs the workflowId, so forms still on the old script are countable", async () => {
    await call("?workflowId=wf_legacy");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("retired URL"),
      expect.objectContaining({ workflowId: "wf_legacy" }),
    );
  });

  it("rate limits the LOG on a fixed key, never the response", async () => {
    // The keyspace must not be caller-controlled: `?workflowId=` is
    // unauthenticated, so keying by it would mint a fresh log budget per value.
    await call("?workflowId=wf_a");
    await call("?workflowId=wf_b");
    for (const [key] of isAllowed.mock.calls as unknown as [string][]) {
      expect(key).toBe("webhook:google-form:retired");
    }
  });

  it("still answers 410 when the log is suppressed", async () => {
    isAllowed.mockReturnValue(false);
    const res = await call();
    expect(res.status).toBe(410);
    expect(warn).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Copy Apps Script"),
    });
  });

  it("answers 410 even if logging throws", async () => {
    // A downed log transport must not turn this into a generic Next 500 HTML
    // page, which is strictly less useful to the form owner than the 410.
    warn.mockImplementationOnce(() => {
      throw new Error("log transport down");
    });
    const res = await call();
    expect(res.status).toBe(410);
    expect(error).toHaveBeenCalled();
  });
});
