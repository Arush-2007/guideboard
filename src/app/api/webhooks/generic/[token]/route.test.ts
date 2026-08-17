import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendWorkflowExecution, findFirst } = vi.hoisted(() => ({
  sendWorkflowExecution: vi.fn(async () => ({ ids: ["evt"] })),
  findFirst: vi.fn(),
}));

vi.mock("@/inngest/utils", () => ({ sendWorkflowExecution }));
vi.mock("@/lib/rate-limit", () => ({ isAllowed: () => true }));
vi.mock("@/lib/db", () => ({
  default: { webhookTrigger: { findFirst } },
}));
// The stored secret is encrypted at rest; the route decrypts before verifying.
vi.mock("@/lib/encryption", () => ({
  decrypt: (value: string) => value.replace(/^enc:/, ""),
}));

import { POST } from "./route";

const SECRET = "per-trigger-secret";
const BODY = JSON.stringify({ hello: "world" });

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

const call = (headers?: Record<string, string>) =>
  POST(
    new Request("https://app.test/api/webhooks/generic/tok", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: BODY,
    }) as never,
    { params: Promise.resolve({ token: "tok" }) },
  );

const givenTrigger = (requireSignature: boolean) => {
  findFirst.mockResolvedValue({
    workflowId: "wf_1",
    secret: `enc:${SECRET}`,
    requireSignature,
    nodeType: "WEBHOOK_TRIGGER",
  });
};

beforeEach(() => {
  sendWorkflowExecution.mockClear();
  findFirst.mockReset();
});

describe("generic webhook — signature NOT required (existing triggers)", () => {
  // Rows that predate the requireSignature column keep the behaviour their
  // caller was built against. Breaking them was never acceptable.
  beforeEach(() => givenTrigger(false));

  it("accepts an unsigned request", async () => {
    const res = await call();
    expect(res.status).toBe(202);
    expect(sendWorkflowExecution).toHaveBeenCalledTimes(1);
  });

  it("still rejects a signature that is present and wrong", async () => {
    const res = await call({ "x-guideboard-signature": "sha256=nope" });
    expect(res.status).toBe(401);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed request", async () => {
    const res = await call({ "x-guideboard-signature": sign(BODY) });
    expect(res.status).toBe(202);
  });
});

describe("generic webhook — signature REQUIRED (new triggers)", () => {
  beforeEach(() => givenTrigger(true));

  it("accepts a correctly signed request", async () => {
    const res = await call({ "x-guideboard-signature": sign(BODY) });
    expect(res.status).toBe(202);
    expect(sendWorkflowExecution).toHaveBeenCalledTimes(1);
  });

  it("REJECTS an unsigned request", async () => {
    // The whole point of the setting: knowing the URL is no longer enough.
    const res = await call();
    expect(res.status).toBe(401);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("tells the caller how to sign, rather than just saying no", async () => {
    const res = await call();
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("X-Guideboard-Signature"),
    });
  });

  it("rejects a signature made with the wrong secret", async () => {
    const res = await call({
      "x-guideboard-signature": sign(BODY, "someone-elses-secret"),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a valid signature over DIFFERENT bytes", async () => {
    // Signing binds the request to its body: a captured signature cannot be
    // replayed with altered content.
    const res = await call({
      "x-guideboard-signature": sign(JSON.stringify({ hello: "other" })),
    });
    expect(res.status).toBe(401);
  });
});

describe("generic webhook — unknown token", () => {
  it("404s before any signature work", async () => {
    findFirst.mockResolvedValue(null);
    const res = await call({ "x-guideboard-signature": sign(BODY) });
    expect(res.status).toBe(404);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("looks the token up SCOPED TO THIS TRIGGER TYPE", async () => {
    // Tokens are unique across the whole table, so a Google Form's token is a
    // real row — and its secret would verify a correct signature. Accepted here
    // it would run that workflow with `initialData.webhook` instead of the
    // `googleForm` context its nodes reference: a "successful" run with every
    // reference blank.
    //
    // The scoping is in the WHERE rather than a check after the lookup, so the
    // wrong-type row is never returned in the first place. That is what this
    // asserts — a route cannot resolve a token without saying which trigger it
    // serves, so the next token webhook gets the guarantee for free.
    givenTrigger(true);
    await call({ "x-guideboard-signature": sign(BODY) });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: "tok", nodeType: "WEBHOOK_TRIGGER" },
      }),
    );
  });
});
