import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTRPC } from "@/trpc/client";
import {
  executionRefetchInterval,
  executionsListRefetchInterval,
  LIST_GRACE_MS,
} from "../lib/poll-interval";
import { useExecutionsParams } from "./use-executions-params";

/**
 * Hook to fetch all executions using suspense.
 *
 * Pass `live` on exactly one consumer per page (the list) to make it
 * self-updating: it polls every few seconds while a row on the page is RUNNING,
 * so a live run flips to SUCCESS/FAILED without a manual refresh, and also polls
 * for a short grace window whenever the list is opened or the tab is refocused,
 * so a run just triggered (here or in another tab) surfaces on its own despite
 * the engine's brief lag before it creates the Execution row. Polling stops when
 * neither holds — zero cost at rest. Other consumers (e.g. pagination) leave
 * `live` off and re-render for free off the shared query cache.
 */
export const useSuspenseExecutions = ({
  live = false,
}: {
  live?: boolean;
} = {}) => {
  const trpc = useTRPC();
  const [params] = useExecutionsParams();
  // Grace window opens on first mount (i.e. opening the list).
  const graceUntilRef = useRef(Date.now() + LIST_GRACE_MS);

  const query = useSuspenseQuery({
    ...trpc.executions.getMany.queryOptions(params),
    refetchInterval: (q) =>
      live
        ? executionsListRefetchInterval(q.state.data, graceUntilRef.current)
        : false,
  });

  const { refetch } = query;
  useEffect(() => {
    if (!live) return;
    // Re-open the grace window and re-arm polling whenever the user returns to
    // the tab/list. The refetch is what restarts the loop: once it resolves,
    // React Query re-evaluates refetchInterval, which now sees an open window.
    const reopen = () => {
      graceUntilRef.current = Date.now() + LIST_GRACE_MS;
      refetch();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reopen();
    };
    window.addEventListener("focus", reopen);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", reopen);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, refetch]);

  return query;
};

/**
 * Hook to fetch a single execution using suspense.
 * Polls while this execution is RUNNING so per-node rows live-update during a run.
 */
export const useSuspenseExecution = (id: string) => {
  const trpc = useTRPC();
  return useSuspenseQuery({
    ...trpc.executions.getOne.queryOptions({ id }),
    refetchInterval: (query) => executionRefetchInterval(query.state.data),
  });
};
