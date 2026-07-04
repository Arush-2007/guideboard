import {
  CredentialsApiKeysSection,
  CredentialsConnectedAppsSection,
  CredentialsContainer,
  CredentialsError,
  CredentialsInstagramAuthErrorToast,
  CredentialsList,
  CredentialsLoading,
  CredentialsYoutubeAuthErrorToast,
} from "@/features/credentials/components/credentials";
import { credentialsParamsLoader } from "@/features/credentials/server/params-loader";
import { prefetchCredentials } from "@/features/credentials/server/prefetch";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";
import { SearchParams } from "nuqs";
import { Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";

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
        <ErrorBoundary fallback={<CredentialsError />}>
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
        </ErrorBoundary>
      </HydrateClient>
    </CredentialsContainer>
  );
};

export default Page;
