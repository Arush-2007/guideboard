import { Suspense } from "react";
import { QueryErrorBoundary } from "@/components/query-error-boundary";
import { AccountCard } from "@/features/profile/components/account-card";
import { ConnectedAccountsCard } from "@/features/profile/components/connected-accounts-card";
import { ProfileHeader } from "@/features/profile/components/profile-header";
import { ProfileSkeleton } from "@/features/profile/components/profile-skeleton";
import { SessionsCard } from "@/features/profile/components/sessions-card";
import { prefetchProfile } from "@/features/profile/server/prefetch";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";

const Page = async () => {
  await requireAuth();

  prefetchProfile();

  return (
    <HydrateClient>
      {/* No page title: the identity card leads with the user's own name and
          photo, which says "profile" more directly than a heading would. */}
      <div className="mx-auto max-w-3xl space-y-6">
        <QueryErrorBoundary message="Error loading your profile">
          {/* One boundary for the whole page: the cards are prefetched
              together, so staggering them would only add flicker. */}
          <Suspense fallback={<ProfileSkeleton />}>
            <div className="space-y-6">
              <ProfileHeader />
              <AccountCard />
              <SessionsCard />
              <ConnectedAccountsCard />
            </div>
          </Suspense>
        </QueryErrorBoundary>
      </div>
    </HydrateClient>
  );
};

export default Page;
