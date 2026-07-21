/**
 * Turns raw OAuth scope strings into what they actually let Guideboard do.
 *
 * A user deciding whether to disconnect an account can't act on
 * `https://www.googleapis.com/auth/gmail.modify`. The mapping covers the scopes
 * this app requests (see `socialProviders` in `src/lib/auth.ts`); anything else
 * falls back to the bare scope name so an unmapped grant is still visible
 * rather than silently hidden.
 */

const SCOPE_LABELS: Record<string, string> = {
  // Identity, requested by every provider.
  openid: "Sign in",
  email: "Email address",
  profile: "Basic profile",
  "user:email": "Email address",
  read: "Read access",
  // The scopes that actually power nodes.
  "https://www.googleapis.com/auth/spreadsheets": "Google Sheets",
  "https://www.googleapis.com/auth/gmail.modify": "Gmail",
  "https://www.googleapis.com/auth/drive.readonly": "Google Drive (read-only)",
  "https://www.googleapis.com/auth/forms.body.readonly":
    "Google Forms (read-only)",
};

/** Strips the Google URL prefix so an unmapped scope still reads as words. */
const shorten = (scope: string): string =>
  scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "");

/**
 * Labels each scope and drops duplicates — several raw scopes can collapse to
 * the same human label (`email` and `user:email`), and showing "Email address"
 * twice looks like a bug.
 */
export function describeScopes(scopes: readonly string[]): string[] {
  const labels = scopes
    .map((scope) => scope.trim())
    .filter(Boolean)
    .map((scope) => SCOPE_LABELS[scope] ?? shorten(scope));

  return [...new Set(labels)];
}
