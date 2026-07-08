import type { SearchParams } from "nuqs";
import { Suspense } from "react";
import { QueryErrorBoundary } from "@/components/query-error-boundary";
import { ExecutionStats } from "@/features/executions/components/execution-stats";
import {
  ExecutionsContainer,
  ExecutionsList,
  ExecutionsLoading,
} from "@/features/executions/components/executions";
import { ExecutionsFilters } from "@/features/executions/components/executions-filters";
import { executionsParamsLoader } from "@/features/executions/server/params-loader";
import { prefetchExecutions } from "@/features/executions/server/prefetch";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";

type Props = {
  searchParams: Promise<SearchParams>;
};

const Page = async ({ searchParams }: Props) => {
  await requireAuth();

  const params = await executionsParamsLoader(searchParams);
  prefetchExecutions(params);

  return (
    <ExecutionsContainer>
      <HydrateClient>
        <div className="mb-6">
          <ExecutionStats />
        </div>
        <ExecutionsFilters />
        <QueryErrorBoundary message="Error loading executions">
          <Suspense fallback={<ExecutionsLoading />}>
            <ExecutionsList />
          </Suspense>
        </QueryErrorBoundary>
      </HydrateClient>
    </ExecutionsContainer>
  );
};

export default Page;
