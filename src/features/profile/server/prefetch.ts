import { prefetch, trpc } from "@/trpc/server";

/**
 * Warms every query the profile page's cards suspend on, so the whole page
 * paints in one pass instead of cascading spinners.
 */
export const prefetchProfile = () => {
  prefetch(trpc.profile.get.queryOptions());
  prefetch(trpc.profile.listSessions.queryOptions());
  prefetch(trpc.profile.listConnectedAccounts.queryOptions());
  prefetch(trpc.profile.googleDependentWorkflowCount.queryOptions());
};
