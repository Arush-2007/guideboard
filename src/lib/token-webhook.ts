import { type NextRequest, NextResponse } from "next/server";
import type { NodeType } from "@/generated/prisma";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { isAllowed } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/webhook-verify";

/**
 * ## The single door for a TOKEN-authenticated webhook
 *
 * `verifyWebhookRequest` owns one decision: is this request signed correctly.
 * This owns everything a token-addressed route must do around it — rate limit,
 * cap the body, read the raw bytes, resolve the token to its trigger, verify.
 *
 * It exists for the same reason `verifyWebhookRequest` does, one layer up. That
 * function was written because six routes hand-rolled their auth preamble and
 * one of them got it wrong. The token routes then grew a SECOND hand-rolled
 * preamble around it — ~73 near-identical lines each — carrying a decision just
 * as easy to omit:
 *
 * **A token must be scoped to its node type.** `WebhookTrigger.token` is unique
 * across the whole table, so a token minted for one trigger authenticates at
 * every token route unless each one remembers to check. A generic webhook's
 * token accepted at the Google Form endpoint does not fail — it runs that
 * workflow with `initialData.googleForm` where its nodes expect
 * `initialData.webhook`, so every reference resolves blank and the run
 * "succeeds". Silent, and worse than a rejection.
 *
 * Here that cannot be forgotten: `nodeType` is a required argument and it goes
 * into the WHERE clause, so a route cannot query for a token without saying
 * which trigger it wants. "Forgot to scope by type" stops being expressible,
 * which is the same move `verifyWebhookRequest` made for "forgot to decide what
 * an unset secret means". A third token webhook gets the check for free.
 *
 * What deliberately stays in the routes: body parsing (lenient vs strict),
 * `initialData` shaping, the idempotency key, and the success status (202 vs
 * 200). Those are genuinely per-provider, and folding them in here would make a
 * handler factory that each new provider has to fight.
 */

/**
 * 1 MB. A form response or webhook payload is small; anything larger is almost
 * certainly abuse, and it would bloat the `Execution.input` this persists.
 * Declared once — two routes each carrying their own copy, with a comment on one
 * promising it matched the other, is a promise nothing enforced.
 */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Reads the body as TEXT, abandoning it the moment it exceeds the cap. Returns
 * null if it did.
 *
 * TEXT, not `json()`: the signature covers the exact bytes sent, and a
 * re-serialized object would not reproduce them.
 *
 * STREAMED, not `request.text()`: buffering first and measuring afterwards
 * enforces the cap only in the sense that it tells you, once the memory is
 * already spent, that you should not have spent it. A caller posting a
 * multi-gigabyte chunked body — no `content-length`, so the declared-size check
 * above has nothing to reject — would exhaust the process before the check ran.
 * Here the read stops within one chunk of the limit and cancels the stream, so
 * the peak cost of a hostile body is bounded by the cap rather than by what the
 * sender chose to send.
 */
async function readBodyCapped(request: NextRequest): Promise<string | null> {
  const stream = request.body;
  // No stream to read (an already-buffered request, or no body at all). Nothing
  // to bound incrementally, so take it whole — the declared-size check above and
  // the byte count below still apply.
  if (!stream) {
    const whole = await request.text();
    return Buffer.byteLength(whole, "utf8") > MAX_BODY_BYTES ? null : whole;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        // Tell the sender to stop; do not keep what has arrived.
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

export type TokenWebhookAuthResult =
  | { ok: true; workflowId: string; rawBody: string }
  | { ok: false; response: NextResponse };

type AuthenticateTokenWebhookArgs = {
  request: NextRequest;
  /** The URL segment presented as the credential. */
  token: string;
  /**
   * Which trigger this endpoint serves. Required, and applied in the WHERE
   * clause rather than checked afterwards — see the docblock. A token belonging
   * to another trigger type is reported as unknown rather than refused, so a
   * wrong-endpoint token looks identical to a made-up one to anyone probing.
   */
  nodeType: NodeType;
  /**
   * What to tell a caller that must sign but didn't. Per-provider because the
   * person reading it differs: a form owner is told to re-copy their Apps
   * Script, an API integrator is told the header format.
   */
  signatureRequiredMessage: string;
};

export async function authenticateTokenWebhook({
  request,
  token,
  nodeType,
  signatureRequiredMessage,
}: AuthenticateTokenWebhookArgs): Promise<TokenWebhookAuthResult> {
  const reject = (status: number, error: string): TokenWebhookAuthResult => ({
    ok: false,
    response: NextResponse.json({ success: false, error }, { status }),
  });

  // Per token AND per endpoint, before any DB work, so a flood cannot drive
  // database load and one provider's traffic cannot exhaust another's bucket.
  if (!isAllowed(`webhook:${nodeType}:${token}`, 100, 60_000)) {
    return reject(429, "Too many requests");
  }

  // Reject on the DECLARED size first — cheap, and it avoids reading a body
  // that is only going to be thrown away. Only meaningful when the header is
  // actually present: `Number(null)` is 0, which is finite and under the cap, so
  // testing the parsed value alone would silently wave through every request
  // that omits the header. That is not an edge case — a chunked request has no
  // `content-length` by definition.
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredLength = Number(declared);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return reject(413, "Payload too large");
    }
  }

  const rawBody = await readBodyCapped(request);
  if (rawBody === null) return reject(413, "Payload too large");

  // `findFirst` rather than `findUnique`, because the WHERE carries `nodeType`
  // alongside the unique token — the scoping is done by the query, not by a
  // check a caller could leave out. Still a single index hit on `token`.
  const trigger = await prisma.webhookTrigger.findFirst({
    where: { token, nodeType },
    select: { workflowId: true, secret: true, requireSignature: true },
  });
  if (!trigger) return reject(404, "Unknown webhook");

  // `secretSource: "database"` because this secret is a per-trigger column, not
  // an environment variable. That branch is REACHABLE — a row whose secret
  // decrypts to empty after a bad `ENCRYPTION_KEY` rotation, a truncated
  // column, a hand-seeded row — and saying where the value comes from is what
  // makes its 503 name the real fix (regenerate the webhook) rather than
  // sending the reader to a `.env` file that has nothing to do with it.
  //
  // `requireSignature` is per-row: anything provisioned now is created with it
  // true, so a caller set up with the current instructions always signs. The
  // `if-present` branch serves rows created before that, and still verifies a
  // signature whenever one is offered.
  const auth = verifyWebhookRequest({
    request,
    rawBody,
    scheme: { kind: "hmac-sha256", header: "x-guideboard-signature" },
    secret: decrypt(trigger.secret),
    secretName: "WebhookTrigger.secret",
    secretSource: "database",
    ...(trigger.requireSignature
      ? { mode: "required" as const, invalidMessage: signatureRequiredMessage }
      : { mode: "if-present" as const, invalidMessage: "Invalid signature" }),
  });
  if (!auth.ok) return { ok: false, response: auth.response };

  return { ok: true, rawBody, workflowId: trigger.workflowId };
}
