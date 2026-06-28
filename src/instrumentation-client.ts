import * as Sentry from "@sentry/nextjs";

// Browser SDK init. Like instrumentation.ts this must live in `src/` (next to
// `app/`) to be detected when the project uses a `src/` directory. The client
// can only read NEXT_PUBLIC_* env, so the DSN must be exposed as
// NEXT_PUBLIC_SENTRY_DSN. No DSN => no-op (local/dev/test).
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    enabled: process.env.NODE_ENV === "production",
    tracesSampleRate: Number(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1",
    ),
  });
}

// Lets Sentry trace client-side navigations (App Router).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
