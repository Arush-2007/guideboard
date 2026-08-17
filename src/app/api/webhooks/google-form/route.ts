/**
 * Retired Google Form webhook endpoint — `POST /api/webhooks/google-form`.
 *
 * Superseded by `/api/webhooks/google-form/<token>`, which authenticates with a
 * per-workflow token + HMAC instead of a global shared secret and a forgeable
 * `?workflowId=` parameter. See that route's docblock for the full reasoning.
 *
 * ## What this can and cannot do
 *
 * Every Apps Script already installed in a user's Google Form still posts here,
 * and those scripts cannot be updated remotely — the user has to re-copy the
 * script from the node. So this path keeps receiving traffic from forms that
 * are, from the user's point of view, "connected".
 *
 * Be clear-eyed about how little of that reaches the form owner. The OLD script
 * calls `UrlFetchApp.fetch` without `muteHttpExceptions`, inside a try/catch that
 * only `console.error`s — the same swallowing that made the original breakage
 * invisible. So a non-2xx here becomes an Apps Script exception whose text is
 * TRUNCATED after roughly the first line of our body, caught, and written to an
 * execution log nobody is watching. The run is not marked failed, so Google sends
 * the owner no email.
 *
 * Given that, each choice below earns its place differently:
 *
 *  - **410, not 503.** The endpoint is gone, not misconfigured. A 503 invited
 *    the operator to go hunting for a missing environment variable, which is
 *    exactly the wrong place — that was the confusing symptom this whole change
 *    started from. It is also the only status that produces any owner-visible
 *    trace at all: a 2xx would be swallowed in total silence.
 *  - **The message leads with the instruction**, because only its first ~100
 *    characters survive Apps Script's truncation. Everything after the first
 *    sentence is a bonus for whoever reads the full response by hand.
 *  - **The warn log is the real signal.** It is what tells an operator how many
 *    forms are still on the old script, and it is the only channel here that
 *    reliably reaches a human. Migration is driven from this, not from the body.
 *
 * The gap this does NOT close: the form owner still gets no proactive notice
 * that their trigger stopped firing. Closing it needs an in-app notification
 * keyed off this log, which is a feature rather than a fix.
 *
 * Deletable once no form is posting here — the log is what says when.
 */

import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { isAllowed } from "@/lib/rate-limit";

const MIGRATION_MESSAGE =
  "Re-copy the Apps Script from the Google Form node in Guideboard — this " +
  "webhook URL is retired and this submission was NOT delivered. Open the " +
  "workflow, click the Google Form trigger, and use 'Copy Apps Script'. Then in " +
  "your form open the ⋮ menu > Apps Script, replace the script, and run setup " +
  "once. The new script uses a private per-form URL and signs each submission.";

/**
 * Refusing costs nothing and is identical for every caller, so the response is
 * never rate limited — only the log write is, which is the one thing here that
 * consumes an unbounded resource.
 *
 * The key is FIXED. Keying it by the `?workflowId=` would be per-workflow
 * fairness bought with an attacker-controlled keyspace: that parameter is
 * unauthenticated and unbounded, so each distinct value would mint its own fresh
 * budget and the limit would stop being a limit. Nothing is lost by sharing one
 * bucket, because every caller receives the same 410 either way — a suppressed
 * log line costs an operator a count, not a form owner their instructions.
 */
const LOG_KEY = "webhook:google-form:retired";
const LOGS_PER_MINUTE = 100;

export async function POST(request: NextRequest) {
  try {
    // The workflow id is the only identifying thing the old script sent, and it
    // is unauthenticated — so it is logged as a migration breadcrumb, never
    // trusted and never used as a key. `new URL(request.url)` rather than
    // `request.nextUrl`: the latter exists only on a real NextRequest.
    const workflowId = new URL(request.url).searchParams.get("workflowId");

    if (isAllowed(LOG_KEY, LOGS_PER_MINUTE, 60_000)) {
      logger.warn(
        "Google Form webhook hit the retired URL — the form is still on the old Apps Script",
        { workflowId },
      );
    }
  } catch (error) {
    // A malformed request URL or a downed log transport must not turn this into
    // a generic Next 500 HTML page: that is strictly less useful to the form
    // owner than the 410 below, which at least names the fix.
    logger.error("Retired Google Form webhook failed to log a caller", {
      error,
    });
  }

  return NextResponse.json(
    { success: false, error: MIGRATION_MESSAGE },
    { status: 410 },
  );
}
