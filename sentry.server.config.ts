import * as Sentry from "@sentry/nextjs";

// No DSN => no-op. This keeps local/dev/test runs free of Sentry traffic; only
// production deployments supply a DSN. `enabled` is an extra guard so a build
// that happens to inherit a DSN outside production still stays silent.
const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    enabled: process.env.NODE_ENV === "production",
    // Sampled from env so volume never becomes a cost cliff (default low).
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    profilesSampleRate: Number(
      process.env.SENTRY_PROFILES_SAMPLE_RATE ?? "0.1",
    ),
    sendDefaultPii: false,
  });
}
