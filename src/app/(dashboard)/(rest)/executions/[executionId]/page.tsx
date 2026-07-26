import { Suspense } from "react";
import { QueryErrorBoundary } from "@/components/query-error-boundary";
import {
  ExecutionDetailLoading,
  ExecutionView,
} from "@/features/executions/components/execution";
import { prefetchExecution } from "@/features/executions/server/prefetch";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";

interface PageProps {
  params: Promise<{
    executionId: string;
  }>;
}

const Page = async ({ params }: PageProps) => {
  await requireAuth();

  const { executionId } = await params;
  prefetchExecution(executionId);

  return (
    // Wide enough for the run summary and the skipped-nodes column beside it.
    // The gutter comes from the (rest) layout; this only sets the max-width.
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-y-8">
      <HydrateClient>
        <QueryErrorBoundary message="Error loading execution">
          <Suspense fallback={<ExecutionDetailLoading />}>
            <ExecutionView executionId={executionId} />
          </Suspense>
        </QueryErrorBoundary>
      </HydrateClient>
    </div>
  );
};

export default Page;
