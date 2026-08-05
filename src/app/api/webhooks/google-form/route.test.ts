import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture what the webhook forwards into the engine without touching Inngest.
const { sendWorkflowExecution } = vi.hoisted(() => ({
  sendWorkflowExecution: vi.fn(async () => ({ ids: ["evt"] })),
}));
vi.mock("@/inngest/utils", () => ({ sendWorkflowExecution }));
// Rate limiter is in-memory + stateful; force "allowed" for determinism.
vi.mock("@/lib/rate-limit", () => ({ isAllowed: () => true }));

import { POST } from "./route";

const SECRET = "test-google-form-secret";

function makeRequest(opts?: { secret?: string | null; query?: string }) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts?.secret !== null)
    headers["x-webhook-secret"] = opts?.secret ?? SECRET;

  return new Request(
    `http://localhost:3000/api/webhooks/google-form?workflowId=wf_1${
      opts?.query ?? ""
    }`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ responses: { Name: "Ada" } }),
    },
  ) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  sendWorkflowExecution.mockClear();
  vi.stubEnv("GOOGLE_FORM_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("google-form webhook auth", () => {
  it("accepts a request presenting the right secret", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(sendWorkflowExecution).toHaveBeenCalledTimes(1);
  });

  it("accepts the secret via the ?secret= query parameter", async () => {
    const res = await POST(
      makeRequest({ secret: null, query: `&secret=${SECRET}` }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a wrong secret", async () => {
    const res = await POST(makeRequest({ secret: "nope" }));
    expect(res.status).toBe(401);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("rejects a request presenting no secret at all", async () => {
    const res = await POST(makeRequest({ secret: null }));
    expect(res.status).toBe(401);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  // ---- the regression this file exists for --------------------------------

  it("REFUSES when the secret is unset, rather than running unauthenticated", async () => {
    // This route used to skip verification entirely when the env var was
    // missing, which — once `env()` started collapsing `.env.example`
    // placeholders to undefined — left it fully open: any anonymous POST could
    // start a billable workflow run.
    vi.stubEnv("GOOGLE_FORM_WEBHOOK_SECRET", "");

    const res = await POST(makeRequest({ secret: null }));
    expect(res.status).toBe(503);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("REFUSES when the secret is still the .env.example placeholder", async () => {
    // A placeholder is a PUBLIC value — anyone reading the repo has it — so it
    // must count as "not configured", not as a working credential.
    vi.stubEnv("GOOGLE_FORM_WEBHOOK_SECRET", "your-random-secret-here");

    const res = await POST(makeRequest({ secret: "your-random-secret-here" }));
    expect(res.status).toBe(503);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });
});
