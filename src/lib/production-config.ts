import { isRealEnvValue } from "./env";

/**
 * Boot-time check that a PRODUCTION deployment is actually configured.
 *
 * Every other configuration check in this codebase is lazy and per-request: a
 * secret that was never set surfaces as a runtime failure the first time
 * something needs it — possibly weeks after deploy, possibly as a webhook that
 * silently stops working, and (before the shared `verifyWebhookRequest` seam)
 * once as an endpoint that ran unauthenticated. Lazy checking is right for
 * OPTIONAL integrations; it is wrong for values whose absence is a security
 * problem rather than a missing feature.
 *
 * So this runs once, at startup, and refuses to boot. A deployment that is
 * going to be insecure should fail loudly on the deploy that introduced it,
 * not quietly at 3am on a Sunday.
 *
 * ## Why production only
 *
 * A developer cloning the repo must be able to `npm run dev` with an unedited
 * `.env` and get a working app to explore. Enforcing every secret locally would
 * make the first-run experience a wall of errors about integrations they have
 * not reached yet. In production there is no equivalent excuse: nobody deploys
 * to serve real traffic by accident.
 *
 * ## What belongs here
 *
 * Only values whose absence is a SECURITY or DATA-INTEGRITY failure — not
 * "this integration will not work". A missing `SLACK_BOT_TOKEN` disables Slack;
 * a missing `ENCRYPTION_KEY` means stored third-party credentials are not
 * protected, and a missing `INNGEST_SIGNING_KEY` means the endpoint that
 * dispatches workflow runs is not verifying who is calling it. Those are
 * different kinds of missing, and only the second kind belongs below.
 *
 * Per-integration webhook secrets are deliberately NOT listed: a deployment
 * that never wired up Typeform should not be forced to invent a Typeform
 * secret. Those are enforced at the point of use by `verifyWebhookRequest`,
 * which refuses the request (503) rather than running unauthenticated.
 */

/** A setting whose absence makes the deployment unsafe, not merely limited. */
type RequiredSetting = {
  key: string;
  /** The resolved value. See `requiredProductionSettings` for why it is read
   * as a literal `process.env.X` rather than looked up by `key`. */
  value: string | undefined;
  /** What breaks without it, in the operator's terms. */
  because: string;
};

/**
 * The settings a production deployment must have.
 *
 * Each `value` is written as a LITERAL `process.env.X` rather than looked up
 * from `key`, because Next.js statically replaces `process.env.X` at build time
 * and a dynamic `process.env[key]` defeats that substitution — the same reason
 * `env()` takes a value rather than a key. So `key` and `value` are stated
 * twice on purpose; they are not redundant.
 *
 * ⚠️ Hand-maintained, with no compiler backstop — the hazard CLAUDE.md
 * describes for the partial node registries. The same knowledge also lives in
 * `.env.example` and `DEPLOYMENT.md`, and nothing links the three. Adding a
 * security-critical secret means editing all of them, and forgetting THIS one
 * is exactly the silent-insecure-boot this module exists to prevent.
 */
export function requiredProductionSettings(): RequiredSetting[] {
  return [
    {
      key: "ENCRYPTION_KEY",
      value: process.env.ENCRYPTION_KEY,
      because:
        "third-party API keys and OAuth tokens are encrypted at rest with it",
    },
    {
      key: "BETTER_AUTH_SECRET",
      value: process.env.BETTER_AUTH_SECRET,
      because: "session cookies are signed with it",
    },
    {
      key: "INNGEST_SIGNING_KEY",
      value: process.env.INNGEST_SIGNING_KEY,
      because:
        "/api/inngest verifies request signatures with it, and that endpoint " +
        "dispatches workflow runs",
    },
    {
      key: "DATABASE_URL",
      value: process.env.DATABASE_URL,
      because: "the application cannot reach its database without it",
    },
  ];
}

/** Every required setting that is unset, blank, or still a placeholder. */
export function missingProductionSettings(
  settings: RequiredSetting[] = requiredProductionSettings(),
): RequiredSetting[] {
  return settings.filter((setting) => !isRealEnvValue(setting.value));
}

/**
 * The message a failing boot prints. Separate from the throw so it can be
 * asserted without catching, and so the wording lives next to the list it
 * describes.
 */
export function describeMissingSettings(missing: RequiredSetting[]): string {
  const lines = missing.map((s) => `  - ${s.key}: ${s.because}`);
  return (
    `Refusing to start: ${missing.length} required ` +
    `${missing.length === 1 ? "setting is" : "settings are"} unset or still ` +
    `set to a placeholder from .env.example.\n\n${lines.join("\n")}\n\n` +
    "A placeholder is a PUBLIC value — anyone with the repository has it — so " +
    "it does not count as configured. Set real values and redeploy."
  );
}

/**
 * Throws when a production deployment is missing a security-critical setting.
 * No-op outside production, and no-op during `next build` (which imports server
 * modules to prerender, without the runtime environment being present).
 */
export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  // `next build` sets this; the build machine legitimately lacks runtime
  // secrets, and failing there would make a correct deployment impossible.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const missing = missingProductionSettings();
  if (missing.length === 0) return;

  throw new Error(describeMissingSettings(missing));
}
