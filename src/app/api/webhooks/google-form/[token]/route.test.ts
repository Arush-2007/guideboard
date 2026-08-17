/**
 * Google Form webhook — route auth, plus the end-to-end check that the SCRIPT
 * WE GENERATE is actually accepted by the ROUTE WE SHIP.
 *
 * That last part is the point of this file. The previous suite tested the route
 * against a hand-written, well-behaved caller: it set the header itself and
 * asserted a 200. So it passed while the generated Apps Script sent no
 * credential at all, and the trigger was broken in production for every user.
 * A green suite proved only that a hypothetical correct caller would work.
 *
 * So `describe("the generated Apps Script")` below does not hand-roll a request.
 * It EXECUTES the generated script against Apps Script shims, captures the exact
 * `UrlFetchApp.fetch` call it makes, and replays that at the real route handler.
 * If the script stops signing, stops sending the header, changes its hex
 * encoding, or posts to the wrong URL, this fails — none of which a hand-written
 * request can detect.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendWorkflowExecution, findUnique } = vi.hoisted(() => ({
  sendWorkflowExecution: vi.fn(async () => ({ ids: ["evt"] })),
  findUnique: vi.fn(),
}));

vi.mock("@/inngest/utils", () => ({ sendWorkflowExecution }));
vi.mock("@/lib/rate-limit", () => ({ isAllowed: () => true }));
vi.mock("@/lib/db", () => ({ default: { webhookTrigger: { findUnique } } }));
vi.mock("@/lib/encryption", () => ({
  decrypt: (value: string) => value.replace(/^enc:/, ""),
}));

import { generateGoogleFormScript } from "@/features/triggers/components/google-form-trigger/utils";
import { POST } from "./route";

const SECRET = "per-form-signing-secret";
const TOKEN = "tok_gform_123";
const URL_FOR_TOKEN = `https://app.test/api/webhooks/google-form/${TOKEN}`;

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

const givenTrigger = (
  overrides: Partial<{
    requireSignature: boolean;
    nodeType: string;
    workflowId: string;
  }> = {},
) => {
  findUnique.mockResolvedValue({
    workflowId: "wf_1",
    secret: `enc:${SECRET}`,
    requireSignature: true,
    nodeType: "GOOGLE_FORM_TRIGGER",
    ...overrides,
  });
};

const post = (body: string, headers: Record<string, string> = {}) =>
  POST(
    new Request(URL_FOR_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }) as never,
    { params: Promise.resolve({ token: TOKEN }) },
  );

beforeEach(() => {
  sendWorkflowExecution.mockClear();
  findUnique.mockReset();
});

// ---------------------------------------------------------------------------
// The regression this file exists for
// ---------------------------------------------------------------------------

/**
 * Runs the generated script's `onFormSubmit` under Apps Script shims and returns
 * the HTTP call it made. Everything the script touches is stubbed at the same
 * boundary Google provides, so the script itself runs unmodified.
 */
function runGeneratedScript(answers: Record<string, string>) {
  const script = generateGoogleFormScript(URL_FOR_TOKEN, SECRET);

  let captured: { url: string; options: Record<string, never> } | null = null;
  let thrown: Error | null = null;

  const Utilities = {
    // Apps Script returns SIGNED bytes (-128..127). Reproducing that exactly is
    // what makes this a real test of the script's hex encoding: a script that
    // forgot to mask with 0xFF would produce "-3a"-style garbage here too, and
    // the route would reject it — which is the whole point.
    computeHmacSha256Signature: (value: string, key: string) =>
      Array.from(createHmac("sha256", key).update(value, "utf8").digest()).map(
        (b) => (b > 127 ? b - 256 : b),
      ),
  };

  const UrlFetchApp = {
    fetch: (url: string, options: Record<string, never>) => {
      captured = { url, options };
      return {
        getResponseCode: () => responseCode,
        getContentText: () => responseBody,
      };
    },
  };

  let responseCode = 200;
  let responseBody = '{"success":true}';

  const itemResponses = Object.entries(answers).map(([title, value]) => ({
    getItem: () => ({ getTitle: () => title }),
    getResponse: () => value,
  }));

  const event = {
    response: {
      getItemResponses: () => itemResponses,
      getId: () => "resp_abc",
      getTimestamp: () => "2026-08-06T00:00:00.000Z",
      getRespondentEmail: () => "respondent@example.com",
    },
    source: { getId: () => "form_1", getTitle: () => "Mahindra Form" },
  };

  // The script is a plain function/var declaration body — evaluating it defines
  // `onFormSubmit` without side effects, and we invoke it ourselves.
  const load = new Function(
    "Utilities",
    "UrlFetchApp",
    `${script}\nreturn { onFormSubmit: onFormSubmit, setup: setup, WEBHOOK_URL: WEBHOOK_URL };`,
  );
  const mod = load(Utilities, UrlFetchApp);

  const invoke = () => {
    try {
      mod.onFormSubmit(event);
    } catch (error) {
      thrown = error as Error;
    }
  };
  invoke();

  return {
    get call() {
      return captured as unknown as {
        url: string;
        options: Record<string, string | Record<string, string> | boolean>;
      };
    },
    get thrown(): Error | null {
      return thrown;
    },
    webhookUrl: mod.WEBHOOK_URL as string,
    replayServerError(code: number, text: string): { thrown: Error | null } {
      responseCode = code;
      responseBody = text;
      captured = null;
      thrown = null;
      invoke();
      return { thrown };
    },
  };
}

describe("the generated Apps Script", () => {
  it("posts a request the real route ACCEPTS", async () => {
    // The end-to-end assertion. Not a hand-built request — the bytes and headers
    // the script itself produced, fed to the handler that actually runs.
    givenTrigger();
    const run = runGeneratedScript({ Name: "Ada", Email: "ada@example.com" });

    const res = await post(
      run.call.options.payload as string,
      run.call.options.headers as Record<string, string>,
    );

    expect(res.status).toBe(200);
    expect(sendWorkflowExecution).toHaveBeenCalledTimes(1);
  });

  it("posts to the token URL, carrying no workflowId to forge", () => {
    const run = runGeneratedScript({ Name: "Ada" });
    expect(run.call.url).toBe(URL_FOR_TOKEN);
    expect(run.call.url).not.toContain("workflowId");
  });

  it("forwards the form's answers under the keys the picker offers", async () => {
    givenTrigger();
    const run = runGeneratedScript({ "  Full Name  ": "Ada" });

    await post(
      run.call.options.payload as string,
      run.call.options.headers as Record<string, string>,
    );

    // Titles are trimmed on both sides so the reference path resolves.
    expect(sendWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        initialData: {
          googleForm: expect.objectContaining({
            responses: { "Full Name": "Ada" },
            respondentEmail: "respondent@example.com",
          }),
        },
      }),
    );
  });

  it("dedupes on the form's responseId, so a retry does not run twice", async () => {
    givenTrigger();
    const run = runGeneratedScript({ Name: "Ada" });

    await post(
      run.call.options.payload as string,
      run.call.options.headers as Record<string, string>,
    );

    expect(sendWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "google-form:resp_abc" }),
    );
  });

  it("THROWS on a rejection instead of swallowing it", () => {
    // The reason a fully-broken trigger went unnoticed until a client complained.
    // Throwing is what marks the Apps Script run failed and makes Google email
    // the form owner.
    const run = runGeneratedScript({ Name: "Ada" });
    const { thrown } = run.replayServerError(401, '{"error":"Unauthorized"}');

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain("401");
    expect(thrown?.message).toContain("Unauthorized");
  });

  it("does not throw on success", () => {
    const run = runGeneratedScript({ Name: "Ada" });
    expect(run.thrown).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route auth
// ---------------------------------------------------------------------------

describe("google-form webhook auth", () => {
  const BODY = JSON.stringify({ responseId: "r1", responses: { Name: "Ada" } });

  it("rejects an unsigned request", async () => {
    givenTrigger();
    const res = await post(BODY);
    expect(res.status).toBe(401);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("rejects a signature made with the wrong secret", async () => {
    givenTrigger();
    const res = await post(BODY, {
      "x-guideboard-signature": sign(BODY, "someone-elses-secret"),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a valid signature over DIFFERENT bytes", async () => {
    givenTrigger();
    const res = await post(BODY, {
      "x-guideboard-signature": sign(JSON.stringify({ responseId: "other" })),
    });
    expect(res.status).toBe(401);
  });

  it("tells the caller to re-copy the script rather than just saying no", async () => {
    givenTrigger();
    const res = await post(BODY);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Re-copy the Apps Script"),
    });
  });

  it("404s an unknown token before any signature work", async () => {
    findUnique.mockResolvedValue(null);
    const res = await post(BODY, { "x-guideboard-signature": sign(BODY) });
    expect(res.status).toBe(404);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("refuses a token belonging to a DIFFERENT trigger type", async () => {
    // A generic webhook's token would otherwise authenticate here and run its
    // workflow with a `googleForm` context its nodes never reference.
    givenTrigger({ nodeType: "WEBHOOK_TRIGGER" });
    const res = await post(BODY, { "x-guideboard-signature": sign(BODY) });
    expect(res.status).toBe(404);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("takes the workflow from the TOKEN, not from the request", async () => {
    // The old route read `?workflowId=`, so anyone holding the one global secret
    // could aim a submission at any workflow. The token names its own workflow.
    givenTrigger({ workflowId: "wf_owned_by_token" });
    const res = await post(BODY, { "x-guideboard-signature": sign(BODY) });

    expect(res.status).toBe(200);
    expect(sendWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf_owned_by_token" }),
    );
  });

  it("still verifies a signature offered by a legacy unsigned-mode row", async () => {
    givenTrigger({ requireSignature: false });
    const res = await post(BODY, { "x-guideboard-signature": "sha256=nope" });
    expect(res.status).toBe(401);
  });
});
