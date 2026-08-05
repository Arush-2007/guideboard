import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";

/**
 * Webhook authentication. `verifyWebhookRequest` at the bottom is the ONLY
 * export, and deliberately so — see its docblock. The primitives above it are
 * module-private because an exported one is a door that bypasses the
 * unset-secret decision, which is the whole thing this module exists to make
 * unskippable.
 *
 * A previous version exported a named wrapper per provider
 * (`verifyInstagramWebhookSignature`, `verifyTypeformWebhookSignature`, …).
 * Once every route moved to the seam those had no callers left but still read
 * as the way to authenticate a webhook, so the next author would have reached
 * for one and rebuilt the hand-rolled preamble by hand.
 */

/** Raw-body HMAC-SHA256 as `sha256=<hex>`, compared in constant time. */
function verifySha256PrefixedHmac(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Raw-body HMAC-SHA1 as `sha1=<hex>`. SHA1 is PubSubHubbub's choice, not ours —
 * YouTube signs with it, so we verify what it sends.
 */
function verifySha1PrefixedHmac(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha1=")) return false;
  const expected = `sha1=${createHmac("sha1", secret).update(rawBody, "utf8").digest("hex")}`;
  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Timing-safe comparison of two shared-secret strings. False when the provided
 * value is missing, the expected value is empty, or the lengths differ (the
 * length of a secret is not itself sensitive).
 */
function timingSafeStringEqual(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (provided == null || expected.length === 0) return false;
  try {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * ## The single door every webhook's authentication goes through
 *
 * Each route used to hand-roll this preamble: read the secret, decide what an
 * unset one means, pick a status, compare. Five of the six reached the right
 * answer by independent good judgement — and the sixth (Google Form) did not,
 * skipping verification entirely when the secret was unset. That was survivable
 * only while an unedited `.env` still counted as "set"; once `env()` began
 * collapsing placeholders to `undefined` the endpoint became fully open, and
 * anonymous POSTs could start billable workflow runs.
 *
 * The fix is not "be careful in six places". It is that **fail-open is no
 * longer expressible**: a missing secret is decided here, once, and no route
 * gets a say. Adding a seventh webhook cannot reintroduce the bug, because the
 * decision is not part of what a new route writes.
 *
 * Returns a ready-to-return `NextResponse` rather than throwing, so a caller
 * cannot accidentally swallow a rejection in the `try/catch` these routes all
 * wrap themselves in — a thrown 401 caught by a generic handler is a 500, or
 * worse, a fall-through.
 */

/** How a caller proves it is allowed to post here. */
export type WebhookAuthScheme =
  /**
   * A static shared secret presented verbatim. Used where the provider offers
   * nothing better (Telegram's `secret_token`) or where we define the contract
   * (Google Form's Apps Script). Weaker than HMAC — it proves the caller knows
   * the secret, but says nothing about the body being unmodified — so prefer
   * HMAC whenever the sender can compute one.
   */
  | { kind: "shared-secret"; header: string; queryParam?: string }
  /** HMAC over the raw body, `sha256=<hex>`. Instagram/Meta, Typeform, ours. */
  | { kind: "hmac-sha256"; header: string }
  /** HMAC over the raw body, `sha1=<hex>`. YouTube PubSubHubbub's choice. */
  | { kind: "hmac-sha1"; header: string };

export type WebhookAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

type VerifyWebhookRequestArgs = {
  request: Request;
  /**
   * The configured secret, passed as a VALUE — never looked up by name here.
   * Next.js statically replaces `process.env.X` at build time and a dynamic
   * `process.env[key]` defeats that, so callers write
   * `secret: process.env.TELEGRAM_WEBHOOK_SECRET`. Placeholders are collapsed
   * to "unset" by `env()` below, so an unedited `.env.example` value — which is
   * PUBLIC, and therefore no secret at all — can never authenticate anyone.
   */
  secret: string | undefined;
  /** The variable's name, so the 503 tells an operator what to go and set. */
  secretName: string;
  /**
   * `"required"` (default) refuses when no credential is presented.
   * `"if-present"` verifies only when the caller chose to sign, for the generic
   * webhook, where an unguessable URL token is the baseline and HMAC is opt-in.
   */
  mode?: "required" | "if-present";
  /**
   * Status for a credential that is present but wrong. Defaults to 401. Routes
   * override only to preserve a contract a provider already sees — Instagram
   * has always answered 403 and Typeform 400, and this refactor is not the
   * place to change what Meta or Typeform observe.
   */
  invalidStatus?: number;
  /** Message for a wrong credential, when the provider's name reads better. */
  invalidMessage?: string;
} & (
  | {
      scheme: { kind: "shared-secret"; header: string; queryParam?: string };
      rawBody?: never;
    }
  // The body is REQUIRED for an HMAC scheme, and it must be the raw text: a
  // signature over a re-serialized object would let an attacker alter bytes
  // that survive the round trip.
  | {
      scheme: { kind: "hmac-sha256" | "hmac-sha1"; header: string };
      rawBody: string;
    }
);

export function verifyWebhookRequest(
  args: VerifyWebhookRequestArgs,
): WebhookAuthResult {
  const {
    request,
    scheme,
    secretName,
    mode = "required",
    invalidStatus = 401,
    invalidMessage,
  } = args;

  const secret = env(args.secret);

  // Unset (or still a placeholder) => refuse. 503, not 401: the caller's
  // credentials are not the problem, the server is unconfigured, and an
  // operator reading the log needs to know which of the two it is.
  if (!secret) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          error:
            `This webhook is not configured. Set ${secretName} to a real ` +
            "value (the placeholder from .env.example does not count).",
        },
        { status: 503 },
      ),
    };
  }

  const presented =
    request.headers.get(scheme.header) ??
    (scheme.kind === "shared-secret" && scheme.queryParam
      ? new URL(request.url).searchParams.get(scheme.queryParam)
      : null);

  // Opt-in signing: no credential offered means this scheme does not apply.
  // Only ever reached where something else already authenticates the request.
  if (presented === null && mode === "if-present") return { ok: true };

  const valid =
    scheme.kind === "shared-secret"
      ? timingSafeStringEqual(presented, secret)
      : scheme.kind === "hmac-sha256"
        ? verifySha256PrefixedHmac(args.rawBody as string, presented, secret)
        : verifySha1PrefixedHmac(args.rawBody as string, presented, secret);

  if (!valid) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: invalidMessage ?? "Unauthorized" },
        { status: invalidStatus },
      ),
    };
  }

  return { ok: true };
}
