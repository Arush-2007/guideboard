import * as Sentry from "@sentry/nextjs";

/**
 * The single logging entry point for the app. All leveled/error logging routes
 * through here so there's one place that decides *where* logs go:
 *
 *   - Always writes to `console.*` (so platform log aggregation — Vercel logs,
 *     Inngest run logs — keeps everything).
 *   - In production, additionally forwards `warn`/`error` to Sentry. Sentry is a
 *     no-op without a DSN (see sentry.*.config.ts), so dev/test/local stay
 *     console-only with zero Sentry traffic.
 *   - `debug` is suppressed in production to keep prod logs (and cost) down.
 *
 * `isProduction` is read per-call rather than cached at module load so tests can
 * exercise both branches by toggling `process.env.NODE_ENV`.
 */
type LogContext = Record<string, unknown>;

const isProduction = () => process.env.NODE_ENV === "production";

export const logger = {
  debug(message: string, context?: LogContext) {
    if (isProduction()) return;
    console.debug(message, context ?? "");
  },

  info(message: string, context?: LogContext) {
    console.info(message, context ?? "");
  },

  warn(message: string, context?: LogContext) {
    console.warn(message, context ?? "");
    if (isProduction()) {
      Sentry.captureMessage(message, { level: "warning", extra: context });
    }
  },

  /**
   * `error` is the highest-value capture point. Pass the caught value as
   * `error` so Sentry gets the real exception (and stack); `message` becomes the
   * human-readable label and `context` adds structured detail.
   */
  error(message: string, error?: unknown, context?: LogContext) {
    console.error(message, error ?? "", context ?? "");
    if (!isProduction()) return;

    if (error !== undefined) {
      Sentry.captureException(error, {
        extra: { logMessage: message, ...context },
      });
    } else {
      Sentry.captureMessage(message, { level: "error", extra: context });
    }
  },
};
