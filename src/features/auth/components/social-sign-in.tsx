"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { INTEGRATIONS } from "@/config/integrations";
import { authClient } from "@/lib/auth-client";
import type { SocialProvider } from "@/lib/social-providers";

type SocialSignInProps = {
  /**
   * The providers to offer, from `configuredSocialProviders()` in the page's
   * server component. Rendering the full list unconditionally is what produced
   * a "Continue with GitHub" button that answered 404 in production.
   */
  providers: SocialProvider[];
  disabled?: boolean;
};

/**
 * The OAuth buttons shared by the login and signup forms.
 *
 * One component rather than the same block pasted into both: the two copies had
 * already drifted into identical bugs, and a fix applied to one of them is a
 * fix that silently misses half the front door.
 */
export function SocialSignIn({ providers, disabled }: SocialSignInProps) {
  const router = useRouter();

  if (providers.length === 0) return null;

  const signIn = async (provider: SocialProvider) => {
    await authClient.signIn.social(
      { provider },
      {
        onSuccess: () => {
          router.push("/");
        },
        // Show what actually failed. This handler used to swallow every error
        // into "Something went wrong", so a total production outage — the
        // database refusing connections, every one of these requests 500ing —
        // was indistinguishable from a declined consent screen, and read to the
        // user as "Google sign-in is broken".
        onError: (ctx) => {
          toast.error(ctx.error.message || "Sign-in failed. Please try again.");
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {providers.map((provider) => {
        const brand = INTEGRATIONS[provider];
        return (
          <Button
            key={provider}
            onClick={() => signIn(provider)}
            variant="outline"
            className="h-10 w-full rounded-xl"
            type="button"
            disabled={disabled}
          >
            <Image
              alt={brand.label}
              src={brand.icon}
              width={20}
              height={20}
              unoptimized
            />
            Continue with {brand.label}
          </Button>
        );
      })}
    </div>
  );
}
