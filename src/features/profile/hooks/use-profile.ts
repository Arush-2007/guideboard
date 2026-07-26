import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

/** The account's own details — name, email, avatar, id, capabilities. */
export const useProfile = () => {
  const trpc = useTRPC();
  return useSuspenseQuery(trpc.profile.get.queryOptions());
};

export const useProfileSessions = () => {
  const trpc = useTRPC();
  return useSuspenseQuery(trpc.profile.listSessions.queryOptions());
};

export const useConnectedAccounts = () => {
  const trpc = useTRPC();
  return useSuspenseQuery(trpc.profile.listConnectedAccounts.queryOptions());
};

export const useGoogleDependentWorkflowCount = () => {
  const trpc = useTRPC();
  return useSuspenseQuery(
    trpc.profile.googleDependentWorkflowCount.queryOptions(),
  );
};

/**
 * Refetches everything the profile page shows. Account mutations go through
 * `authClient` rather than tRPC (see the router's header note), so nothing
 * invalidates the tRPC cache on its own — every one of those calls has to say
 * so explicitly, and they all say it the same way from here.
 */
export const useRefreshProfile = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.profile.get.queryFilter()),
      queryClient.invalidateQueries(trpc.profile.listSessions.queryFilter()),
      queryClient.invalidateQueries(
        trpc.profile.listConnectedAccounts.queryFilter(),
      ),
      // Included so callers don't each have to remember it: this is the count
      // the disconnect confirmation quotes, and a stale one would understate
      // what the user is about to break.
      queryClient.invalidateQueries(
        trpc.profile.googleDependentWorkflowCount.queryFilter(),
      ),
    ]);
};
