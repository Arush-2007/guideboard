import { env } from "@/lib/env";

/**
 * The origins allowed to make state-changing requests to this deployment.
 *
 * Better Auth consumes this as its `trustedOrigins` (every `/api/auth/*` route
 * gets an origin check for free). Custom cookie-authenticated route handlers —
 * which sit outside that check — use `isTrustedOrigin` to get the same
 * protection, so the list is defined once here rather than drifting between
 * the two.
 */

/** localhost is trusted in development only; never in a production build. */
export const trustedOrigins = (): string[] =>
  [
    process.env.NODE_ENV === "development"
      ? "http://localhost:3000"
      : undefined,
    // Through `env(...)`: an unedited `https://your-ngrok-domain.ngrok-free.app`
    // would otherwise be TRUSTED as an origin — a placeholder in this list is a
    // security question, not just a broken integration.
    env(process.env.NEXT_PUBLIC_APP_URL),
    env(process.env.NGROK_URL),
  ].filter((origin): origin is string => Boolean(origin));

/**
 * Whether a request came from somewhere we trust.
 *
 * A cookie-authenticated POST that accepts `multipart/form-data` is a CORS
 * "simple request": the browser sends it cross-origin with the session cookie
 * attached and never fires a preflight, so nothing stops an attacker's page
 * from submitting one on a signed-in user's behalf. Checking the origin is what
 * closes that.
 *
 * `Origin` is set by the browser on every POST and cannot be forged by page
 * script. It is absent on same-origin requests from some non-browser clients
 * (curl, server-to-server), so we fall back to `Referer` and reject only when a
 * cross-origin value is actually present — a missing header was never the
 * attack, since a browser always sends one for the requests this guards.
 */
export function isTrustedOrigin(request: Request): boolean {
  const origin =
    request.headers.get("origin") ??
    (() => {
      const referer = request.headers.get("referer");
      if (!referer) return null;
      try {
        return new URL(referer).origin;
      } catch {
        return null;
      }
    })();

  if (!origin) return true;

  return trustedOrigins().includes(origin);
}
