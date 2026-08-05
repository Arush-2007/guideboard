/**
 * Whether an environment value is real, or still the placeholder `.env.example`
 * ships with.
 *
 * A placeholder is non-empty, so a bare `Boolean(process.env.X)` check passes
 * it and the credential travels on to the provider. Where that merely produces
 * a 401 the cost is small — but where the value becomes part of a URL it is
 * not: R2 built the endpoint
 * `https://your-cloudflare-account-id.r2.cloudflarestorage.com`, Cloudflare had
 * no certificate for that name, and the caller saw a bare
 * `SSL alert number 40` naming no host. Hours went into that before the actual
 * cause — an unedited `.env` — was found.
 *
 * "Not configured" is both the truth and the message that sends someone to
 * their `.env`, so every `is*Configured` probe should route through here.
 */

/**
 * Every placeholder convention `.env.example` actually uses. All three are
 * needed: matching only the first left `ENCRYPTION_KEY` and `DATABASE_URL`
 * looking like real values, so the first `is*Configured` probe added for either
 * would have accepted a public placeholder as a working secret — the exact
 * failure this module exists to end.
 *
 * 1. `your` joined by `-`/`_`, at the start (`your-github-client-id`), after a
 *    provider prefix (`re_your_resend_api_key`), or after a URL scheme
 *    (`https://your-ngrok-domain.ngrok-free.app`).
 * 2. `replace-with-…` / `replace_with_…` — used for `ENCRYPTION_KEY` and
 *    `BETTER_AUTH_SECRET`, the two most damaging values to leave unedited.
 * 3. The literal `USER:PASSWORD@` of the sample Postgres URL.
 *
 * Each requires a separator or a following token rather than matching the bare
 * word, which is what keeps genuine values safe: a real bucket named
 * `yourcompany-prod-assets` has `your` followed by `c`, and a database user
 * literally called `user` is not written in caps followed by `:PASSWORD@`.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /(^|[^a-z0-9])your[-_]/i,
  /(^|[^a-z0-9])replace[-_]with[-_]/i,
  /\bUSER:PASSWORD@/,
];

/**
 * True when `value` is present and not a placeholder — i.e. safe to use. A type
 * predicate so callers reading `process.env` narrow to `string` in one step
 * instead of null-checking separately.
 */
export function isRealEnvValue(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return !PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Reads a setting, collapsing an unedited placeholder to `undefined` — i.e.
 * treating "never filled in" as "not set", which is what it means.
 *
 * This is the main entry point, and it is deliberately shaped to need no new
 * handling downstream: every consumer already copes with a missing setting
 * (`?? fallback`, `Boolean(x)`, `x ? … : null`), so routing the read through
 * here makes all of those paths cover placeholders for free.
 *
 * Takes the VALUE, not the key: Next.js statically replaces `process.env.X` at
 * build time, and a dynamic `process.env[key]` lookup defeats that — silently
 * yielding `undefined` for any `NEXT_PUBLIC_*` var in the browser bundle. So
 * callers write `env(process.env.NGROK_URL)` and keep the substitution.
 */
export function env(value: string | undefined): string | undefined {
  return isRealEnvValue(value) ? value.trim() : undefined;
}

/** Whether every setting is present and real — for `is*Configured` probes. */
export function hasEnv(...values: (string | undefined)[]): boolean {
  return values.every(isRealEnvValue);
}

/**
 * The value, or a consistent throw naming the variable. For the throwing
 * counterpart of a probe — the two must agree on what "configured" means, or a
 * caller that skips the probe slips a placeholder through anyway.
 */
export function requireEnv(
  value: string | undefined,
  key: string,
  /**
   * What the user calls this thing ("CloudConvert"), when that reads better
   * than the variable name. The variable is always named too — the friendly
   * noun says what broke, the key says what to go and edit.
   */
  integration?: string,
): string {
  const resolved = env(value);
  if (resolved === undefined) {
    throw new Error(
      `${integration ?? key} is not configured — set ${key} in your .env to a ` +
        "real value (the placeholder from .env.example does not count).",
    );
  }
  return resolved;
}
