import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

/**
 * Analytics summary for the executions overview. Plain (non-suspense) query so
 * the panel can render its own skeleton without blocking the list.
 */
export const useExecutionStats = (days = 30) => {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.executions.getStats.queryOptions({ days }),
    staleTime: 60_000,
  });
};
