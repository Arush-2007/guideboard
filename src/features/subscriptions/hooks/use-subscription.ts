import { useQuery } from "@tanstack/react-query";

type SubscriptionState = {
  activeSubscriptions?: unknown[];
} | null;

export const useSubscription = () => {
  return useQuery<SubscriptionState>({
    queryKey: ["subscription"],
    queryFn: async () => null,
  });
};

export const useHasActiveSubscription = () => {
  const { data: customerState, isLoading, ...rest } = useSubscription();

  const hasActiveSubscription =
    customerState?.activeSubscriptions &&
    customerState.activeSubscriptions.length > 0;

  return {
    hasActiveSubscription,
    subscription: customerState?.activeSubscriptions?.[0],
    isLoading,
    ...rest,
  };
};
