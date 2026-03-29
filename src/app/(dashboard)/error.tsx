"use client";

import { Button } from "@/components/ui/button";
import { useEffect } from "react";

export default function DashboardError({
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
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="space-y-2">
        <p className="text-sm font-medium text-destructive">Something went wrong</p>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This part of the app failed to load
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {error.message || "Try again or open another page from the sidebar."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
        <Button type="button" variant="outline" asChild>
          <a href="/workflows">Workflows</a>
        </Button>
      </div>
    </div>
  );
}
