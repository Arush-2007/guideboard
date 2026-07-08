import { QueryErrorBoundary } from "@/components/query-error-boundary";
import {
  CredentialsApiKeysSection,
  CredentialsConnectedAppsSection,
  CredentialsContainer,
  CredentialsInstagramAuthErrorToast,
  CredentialsList,
  CredentialsLoading,
  CredentialsYoutubeAuthErrorToast,
} from "@/features/credentials/components/credentials";
import { credentialsParamsLoader } from "@/features/credentials/server/params-loader";
import { prefetchCredentials } from "@/features/credentials/server/prefetch";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";
import type { SearchParams } from "nuqs";
import { Suspense } from "react";

type Props = {
  searchParams: Promise<SearchParams>;
};

const Page = async ({ searchParams }: Props) => {
  await requireAuth();

  const params = await credentialsParamsLoader(searchParams);
  prefetchCredentials(params);

  return (
    <CredentialsContainer>
      <HydrateClient>
        <QueryErrorBoundary message="Error loading credentials">
          <Suspense fallback={null}>
            <CredentialsInstagramAuthErrorToast />
            <CredentialsYoutubeAuthErrorToast />
          </Suspense>
          <CredentialsConnectedAppsSection />
          <CredentialsApiKeysSection>
            <Suspense fallback={<CredentialsLoading />}>
              <CredentialsList />
            </Suspense>
          </CredentialsApiKeysSection>
        </QueryErrorBoundary>
      </HydrateClient>
    </CredentialsContainer>
  );
};

export default Page;
