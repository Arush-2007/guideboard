import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder shaped like the real cards, so the page doesn't jump on hydrate. */
export const ProfileSkeleton = () => (
  <div className="space-y-6">
    <Skeleton className="h-32 rounded-3xl" />
    <Skeleton className="h-64 rounded-3xl" />
    <Skeleton className="h-56 rounded-3xl" />
  </div>
);
