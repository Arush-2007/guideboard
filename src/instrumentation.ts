import * as Sentry from "@sentry/nextjs";

// Next.js loads this once per server runtime. It must live in `src/` (next to
// `app/`) because Next scans the parent of the app dir for the hook — a
// root-level file is silently ignored when the project uses a `src/` directory.
// Each branch pulls in the matching Sentry init (a no-op without a DSN — see the
// root sentry.*.config.ts files).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Before anything else: a production deployment missing a
    // security-critical secret fails HERE, loudly, on the deploy that
    // introduced it — rather than weeks later as a webhook that quietly stops
    // working. No-op in dev and during `next build`; see production-config.ts.
    const { assertProductionConfig } = await import("./lib/production-config");
    assertProductionConfig();

    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// Captures errors thrown in nested React Server Components.
export const onRequestError = Sentry.captureRequestError;
