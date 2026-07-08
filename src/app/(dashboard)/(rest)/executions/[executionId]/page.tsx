import { QueryErrorBoundary } from "@/components/query-error-boundary";
import { ExecutionDetailLoading, ExecutionView } from "@/features/executions/components/execution";
import { prefetchExecution } from "@/features/executions/server/prefetch";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";
import { Suspense } from "react";

interface PageProps {
  params: Promise<{
    executionId: string;
  }>
};

const Page = async ({ params }: PageProps) => {
  await requireAuth();
  
  const { executionId } = await params;
  prefetchExecution(executionId);

  return (
    <div className="p-4 md:px-10 md:py-6 h-full">
      <div className="mx-auto max-w-screen-md w-full flex flex-col gap-y-8 h-full">
        <HydrateClient>
          <QueryErrorBoundary message="Error loading execution">
            <Suspense fallback={<ExecutionDetailLoading />}>
              <ExecutionView executionId={executionId} />
            </Suspense>
          </QueryErrorBoundary>
        </HydrateClient>
      </div>
    </div>
  )
};

export default Page;
