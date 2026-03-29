"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <div className="space-y-2">
        <p className="text-sm font-medium text-destructive">
          Something went wrong
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          We couldn&apos;t load this page
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {error.message ||
            "An unexpected error occurred. Try again or return home."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
        <Button type="button" variant="outline" asChild>
          <a href="/workflows">Go to workflows</a>
        </Button>
      </div>
    </div>
  );
}
