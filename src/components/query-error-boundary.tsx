"use client";

import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorView } from "@/components/entity-components";

// Recoverable error boundary for suspense queries. Server pages render this
// around their `<Suspense>` and pass only serializable props (a message +
// children) — the reset render-props (`QueryErrorResetBoundary` + react-error-
// boundary's `fallbackRender`) can't live in a Server Component, so they're
// encapsulated here. Clicking "Try again" resets the boundary AND clears the
// query error via `reset()`, so the remounted suspense child refetches without
// a page reload.
export const QueryErrorBoundary = ({
  message,
  children,
}: {
  message?: string;
  children: React.ReactNode;
}) => {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          onReset={reset}
          fallbackRender={({ resetErrorBoundary }) => (
            <ErrorView message={message} onRetry={resetErrorBoundary} />
          )}
        >
          {children}
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
};
