"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

const STORAGE_KEY = "notifications_last_seen";

export function useNotifications() {
  const trpc = useTRPC();

  const { data: failures = [], isLoading } = useQuery({
    ...trpc.executions.getRecentFailures.queryOptions(),
    // Background badge poll: 60s, and paused while the tab is hidden
    // (refetchIntervalInBackground defaults to false). The unseen-count badge
    // needs this data even when the popover is closed, so it can't be gated on
    // popover open.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });

  // Initialize to 0 (SSR-safe); read localStorage only after mount
  const [lastSeen, setLastSeen] = useState(0);
  useEffect(() => {
    setLastSeen(Number(localStorage.getItem(STORAGE_KEY) ?? "0"));
  }, []);

  function markSeen() {
    const now = Date.now();
    localStorage.setItem(STORAGE_KEY, now.toString());
    setLastSeen(now);
  }

  const unseenCount = failures.filter(
    (f) => new Date(f.startedAt).getTime() > lastSeen,
  ).length;

  return { failures, isLoading, unseenCount, markSeen };
}
