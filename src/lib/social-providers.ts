import { env } from "@/lib/env";

/**
 * The OAuth sign-in providers this app knows how to offer.
 *
 * Whether each one is actually AVAILABLE depends on its credentials being set,
 * and that question is answered here rather than in two places. Better Auth
 * registers a provider only when configured (`src/lib/auth.ts`), and the login
 * and signup pages render a button only when configured — both from this
 * module, so the two can never disagree.
 *
 * They did disagree, and it shipped: production had no `GITHUB_CLIENT_ID`, so
 * Better Auth never registered GitHub while both forms still rendered a
 * "Continue with GitHub" button. Pressing it returned 404 `PROVIDER_NOT_FOUND`.
 * A button that the server has no route for is not a configuration slip to be
 * noticed later, it is a dead control on the front door.
 *
 * Names match their `INTEGRATIONS` keys (`src/config/integrations.ts`), which is
 * what lets the button read its label and logo from the brand registry — adding
 * a provider here without a brand entry is a compile error rather than a
 * missing icon.
 */
export const SOCIAL_PROVIDERS = ["github", "google"] as const;

export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export type SocialProviderCredentials = {
  clientId: string;
  clientSecret: string;
};

/**
 * Each provider's credentials, or `undefined` where it is not configured.
 *
 * Read through `env(...)`, so an unedited `.env.example` placeholder counts as
 * absent: registering a provider with a placeholder credential fails at the
 * OAuth redirect, on the provider's own error page, which is a far worse thing
 * to debug than the provider simply not being offered.
 *
 * Each read is written as a literal `process.env.X`. Next.js substitutes those
 * statically at build time and a dynamic `process.env[key]` lookup defeats the
 * substitution — the same reason `env()` takes a value rather than a key.
 */
export function socialProviderCredentials(): Record<
  SocialProvider,
  SocialProviderCredentials | undefined
> {
  const pair = (
    clientId: string | undefined,
    clientSecret: string | undefined,
  ) => (clientId && clientSecret ? { clientId, clientSecret } : undefined);

  return {
    github: pair(
      env(process.env.GITHUB_CLIENT_ID),
      env(process.env.GITHUB_CLIENT_SECRET),
    ),
    google: pair(
      env(process.env.GOOGLE_CLIENT_ID),
      env(process.env.GOOGLE_CLIENT_SECRET),
    ),
  };
}

/**
 * The providers a user can actually sign in with.
 *
 * Server-only — the credentials it reads are deliberately not `NEXT_PUBLIC_*`.
 * Call it in a server component and pass the result down to the form.
 */
export function configuredSocialProviders(): SocialProvider[] {
  const credentials = socialProviderCredentials();
  return SOCIAL_PROVIDERS.filter(
    (provider) => credentials[provider] !== undefined,
  );
}
