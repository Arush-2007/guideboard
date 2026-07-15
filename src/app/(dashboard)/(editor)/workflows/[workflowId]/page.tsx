import { Suspense } from "react";
import { QueryErrorBoundary } from "@/components/query-error-boundary";
import { Editor, EditorLoading } from "@/features/editor/components/editor";
import { EditorHeader } from "@/features/editor/components/editor-header";
import { prefetchWorkflow } from "@/features/workflows/server/prefetch";
import { requireAuth } from "@/lib/auth-utils";
import { HydrateClient } from "@/trpc/server";

interface PageProps {
  params: Promise<{
    workflowId: string;
  }>;
}

const Page = async ({ params }: PageProps) => {
  await requireAuth();

  const { workflowId } = await params;
  prefetchWorkflow(workflowId);

  return (
    <HydrateClient>
      <QueryErrorBoundary message="Error loading editor">
        <Suspense fallback={<EditorLoading />}>
          <EditorHeader workflowId={workflowId} />
          <main className="relative flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <Editor workflowId={workflowId} />
            </div>
          </main>
        </Suspense>
      </QueryErrorBoundary>
    </HydrateClient>
  );
};

export default Page;
