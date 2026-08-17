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
 * It EXECUTES the generated script (via the shared Apps Script harness),
 * captures the exact `UrlFetchApp.fetch` call it makes, and replays that at the
 * real route handler. If the script stops signing, stops sending the header,
 * changes its hex encoding, or posts to the wrong URL, this fails — none of
 * which a hand-written request can detect.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendWorkflowExecution, findFirst } = vi.hoisted(() => ({
  sendWorkflowExecution: vi.fn(async () => ({ ids: ["evt"] })),
  findFirst: vi.fn(),
}));

vi.mock("@/inngest/utils", () => ({ sendWorkflowExecution }));
vi.mock("@/lib/rate-limit", () => ({ isAllowed: () => true }));
vi.mock("@/lib/db", () => ({ default: { webhookTrigger: { findFirst } } }));
vi.mock("@/lib/encryption", () => ({
  decrypt: (value: string) => value.replace(/^enc:/, ""),
}));

import { generateGoogleFormScript } from "@/features/triggers/components/google-form-trigger/utils";
import {
  type CapturedFetch,
  requireRequest,
  runGeneratedFormScript,
  signBody,
} from "@/test/apps-script-harness";
import { POST } from "./route";

const SECRET = "per-form-signing-secret";
const TOKEN = "tok_gform_123";
const URL_FOR_TOKEN = `https://app.test/api/webhooks/google-form/${TOKEN}`;

const sign = (body: string, secret = SECRET) => signBody(body, secret);

/**
 * The row the lookup finds. Scoping by nodeType now happens in the WHERE, so a
 * token belonging to another trigger simply does not match — `givenNoTrigger`
 * is what that looks like from here.
 */
const givenTrigger = (
  overrides: Partial<{ requireSignature: boolean; workflowId: string }> = {},
) => {
  findFirst.mockResolvedValue({
    workflowId: "wf_1",
    secret: `enc:${SECRET}`,
    requireSignature: true,
    ...overrides,
  });
};

const givenNoTrigger = () => findFirst.mockResolvedValue(null);

const post = (body: string, headers: Record<string, string> = {}) =>
  POST(
    new Request(URL_FOR_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }) as never,
    { params: Promise.resolve({ token: TOKEN }) },
  );

/** Generates the real script for this token/secret and runs it. */
const submit = (answers: Record<string, string>, server = {}) =>
  runGeneratedFormScript(generateGoogleFormScript(URL_FOR_TOKEN, SECRET), {
    answers,
    ...server,
  });

/** Replays a captured script request at the real handler. */
const deliver = (call: CapturedFetch | null) => {
  const sent = requireRequest({ call });
  return post(sent.options.payload, sent.options.headers);
};

beforeEach(() => {
  sendWorkflowExecution.mockClear();
  findFirst.mockReset();
});

// ---------------------------------------------------------------------------
// The regression this file exists for
// ---------------------------------------------------------------------------

describe("the generated Apps Script", () => {
  it("posts a request the real route ACCEPTS", async () => {
    // The end-to-end assertion. Not a hand-built request — the bytes and headers
    // the script itself produced, fed to the handler that actually runs.
    givenTrigger();
    const res = await deliver(
      submit({ Name: "Ada", Email: "ada@example.com" }).call,
    );

    expect(res.status).toBe(200);
    expect(sendWorkflowExecution).toHaveBeenCalledTimes(1);
  });

  it("posts to the token URL, carrying no workflowId to forge", () => {
    const sent = requireRequest(submit({ Name: "Ada" }));
    expect(sent.url).toBe(URL_FOR_TOKEN);
    expect(sent.url).not.toContain("workflowId");
  });

  it("forwards the form's answers under the keys the picker offers", async () => {
    givenTrigger();
    await deliver(submit({ "  Full Name  ": "Ada" }).call);

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
    await deliver(submit({ Name: "Ada" }).call);

    expect(sendWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "google-form:resp_abc" }),
    );
  });

  it("THROWS on a rejection instead of swallowing it", () => {
    // The reason a fully-broken trigger went unnoticed until a client complained.
    // Throwing is what marks the Apps Script run failed and makes Google email
    // the form owner.
    const { thrown } = submit(
      { Name: "Ada" },
      { responseCode: 401, responseBody: '{"error":"Unauthorized"}' },
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain("401");
    expect(thrown?.message).toContain("Unauthorized");
  });

  it("does not throw on success", () => {
    expect(submit({ Name: "Ada" }).thrown).toBeNull();
  });

  it("signs NON-ASCII answers so the route still accepts them", async () => {
    // Every other fixture here is ASCII, where a signature agrees with the
    // route's UTF-8 hash no matter which charset the script happened to use.
    // These answers are the case that separates them — and the consequence of
    // getting it wrong is no longer a silent skip but a 401, which this script
    // (correctly) turns into a failed submission and an email to the form owner.
    givenTrigger();
    const { call, thrown } = submit({
      Name: "José Ströaß",
      "पूरा नाम": "अरव जैन",
      Feedback: "Works great 🎉 — 90% faster",
    });

    expect(thrown).toBeNull();
    const res = await deliver(call);

    expect(res.status).toBe(200);
    expect(sendWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        initialData: {
          googleForm: expect.objectContaining({
            responses: {
              Name: "José Ströaß",
              "पूरा नाम": "अरव जैन",
              Feedback: "Works great 🎉 — 90% faster",
            },
          }),
        },
      }),
    );
  });

  it("states the charset instead of relying on an overload's default", () => {
    // The harness refuses `computeHmacSha256Signature(value, key)` outright, so
    // this is belt-and-braces on the reason: the bytes signed must be the bytes
    // the route hashes, and only the 4-argument call says which those are.
    const script = generateGoogleFormScript(URL_FOR_TOKEN, SECRET);
    expect(script).toContain("Utilities.Charset.UTF_8");
    expect(script).not.toContain("computeHmacSha256Signature");
  });

  it("would FAIL this suite if it reverted to the charset-less overload", () => {
    // Proves the backstop, rather than trusting it. A guard nobody has seen
    // reject anything is how the original bug survived a green suite: the
    // charset-less call is what a future "simplification" reaches for, and it
    // passes every ASCII fixture in this file.
    const reverted = generateGoogleFormScript(URL_FOR_TOKEN, SECRET).replace(
      /Utilities\.computeHmacSignature\([\s\S]*?\)/,
      "Utilities.computeHmacSha256Signature(body, SIGNING_SECRET)",
    );

    expect(() =>
      runGeneratedFormScript(reverted, { answers: { Name: "Ada" } }),
    ).toThrow(/does not state a charset/);
  });
});

// ---------------------------------------------------------------------------
// Route auth
// ---------------------------------------------------------------------------

describe("google-form webhook auth", () => {
  const BODY = JSON.stringify({ responseId: "r1", responses: { Name: "Ada" } });

  it("looks the token up SCOPED TO THIS TRIGGER TYPE", async () => {
    // The guarantee that keeps a generic webhook's token from authenticating
    // here. It is in the WHERE, not a check after the fact, so a route cannot
    // resolve a token without saying which trigger it serves.
    givenTrigger();
    await post(BODY, { "x-guideboard-signature": sign(BODY) });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: TOKEN, nodeType: "GOOGLE_FORM_TRIGGER" },
      }),
    );
  });

  it("404s a token that matches no Google Form trigger", async () => {
    // Covers both an unknown token and one belonging to another trigger type —
    // indistinguishable by design, so a probe learns nothing.
    givenNoTrigger();
    const res = await post(BODY, { "x-guideboard-signature": sign(BODY) });

    expect(res.status).toBe(404);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

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

// ---------------------------------------------------------------------------
// Body handling
// ---------------------------------------------------------------------------

describe("google-form webhook body handling", () => {
  it("400s a body that is valid JSON but not an object", async () => {
    // `null`, `42` and `"hi"` all parse, so the JSON catch never fires for
    // them. Dereferencing the result would make each a 500 plus an error log,
    // where the intent is plainly a 400 for a malformed caller.
    givenTrigger();
    for (const scalar of ["null", "42", '"hi"', "[]"]) {
      const res = await post(scalar, {
        "x-guideboard-signature": sign(scalar),
      });
      expect(res.status).toBe(400);
    }
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON at all", async () => {
    givenTrigger();
    const res = await post("not json", {
      "x-guideboard-signature": sign("not json"),
    });
    expect(res.status).toBe(400);
  });

  it("413s an oversized body that declares its size", async () => {
    givenTrigger();
    const res = await POST(
      new Request(URL_FOR_TOKEN, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(2_000_000),
        },
        body: JSON.stringify({ responseId: "r1" }),
      }) as never,
      { params: Promise.resolve({ token: TOKEN }) },
    );

    expect(res.status).toBe(413);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });

  it("413s an oversized body that declares NOTHING, without buffering it whole", async () => {
    // The gap this closes: `Number(null)` is 0, so a request with no
    // `content-length` — which is every chunked request — passed the declared
    // size check, and the read that followed was unbounded. The stream below
    // would produce 2 GB if drained; the read must abandon it near the 1 MB cap
    // instead, so the test finishing at all is part of the assertion.
    givenTrigger();

    const chunk = new Uint8Array(64 * 1024).fill(0x61); // 64 KB of "a"
    let produced = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 2_000 * 1024 * 1024) return controller.close();
        produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const res = await POST(
      new Request(URL_FOR_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // @ts-expect-error — undici requires this for a streaming body.
        duplex: "half",
      }) as never,
      { params: Promise.resolve({ token: TOKEN }) },
    );

    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    // Bounded by the cap, not by what the sender chose to send.
    expect(produced).toBeLessThan(2 * 1024 * 1024);
    expect(sendWorkflowExecution).not.toHaveBeenCalled();
  });
});
