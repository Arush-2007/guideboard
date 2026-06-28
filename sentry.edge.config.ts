import * as Sentry from "@sentry/nextjs";

// Edge runtime (middleware, edge routes). No DSN => no-op; see
// sentry.server.config.ts. Profiling is not supported on the edge runtime, so
// only tracing is sampled here.
const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    enabled: process.env.NODE_ENV === "production",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
  });
}
