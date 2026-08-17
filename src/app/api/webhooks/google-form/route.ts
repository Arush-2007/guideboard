/**
 * Retired Google Form webhook endpoint — `POST /api/webhooks/google-form`.
 *
 * Superseded by `/api/webhooks/google-form/<token>`, which authenticates with a
 * per-workflow token + HMAC instead of a global shared secret and a forgeable
 * `?workflowId=` parameter. See that route's docblock for the full reasoning.
 *
 * ## Why this stays instead of being deleted
 *
 * Every Apps Script already installed in a user's Google Form still posts here,
 * and those scripts cannot be updated remotely — the user has to re-copy the
 * script from the node. So this path keeps receiving traffic from forms that
 * are, from the user's point of view, "connected".
 *
 * What it does about that is the point:
 *
 *  - **410, not 503.** The endpoint is gone, not misconfigured. A 503 invited
 *    the operator to go looking for a missing environment variable, which is
 *    exactly the wrong place — that was the confusing symptom this whole change
 *    started from.
 *  - **It says what to do**, in a message aimed at the person reading an Apps
 *    Script execution log, who is the form owner rather than an operator.
 *  - **It logs at warn**, so the number of forms still on the old script is
 *    observable while the migration is in flight, rather than being guessed at.
 *
 * Deletable once no form is posting here — the log is what says when.
 */

import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { isAllowed } from "@/lib/rate-limit";

const MIGRATION_MESSAGE =
  "This Google Form webhook URL has been retired. Open the workflow in " +
  "Guideboard, click the Google Form trigger, and use 'Copy Apps Script' to " +
  "get the current script — then replace the script in your form (Extensions " +
  "> Apps Script) and run setup once. The new script uses a private per-form " +
  "URL and signs each submission.";

export async function POST(request: NextRequest) {
  // Rate-limited like any public endpoint: this refuses every caller, but it is
  // still reachable by anyone and should not be a free way to generate log volume.
  if (!isAllowed("webhook:google-form:retired", 100, 60_000)) {
    return NextResponse.json(
      { success: false, error: "Too many requests" },
      { status: 429 },
    );
  }

  // The workflow id is the only identifying thing the old script sent, and it is
  // unauthenticated — so it is logged as a migration breadcrumb, never trusted.
  const workflowId = new URL(request.url).searchParams.get("workflowId");
  logger.warn(
    "Google Form webhook hit the retired URL — the form is still on the old Apps Script",
    { workflowId },
  );

  return NextResponse.json(
    { success: false, error: MIGRATION_MESSAGE },
    { status: 410 },
  );
}
