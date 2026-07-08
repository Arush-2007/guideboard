import { ExecutionStatus } from "@/generated/prisma";

/**
 * Poll cadence (ms) used to keep executions views live while a run is in flight
 * (or the list is being actively watched). These helpers back the
 * `refetchInterval` callbacks on the executions suspense queries: they return
 * the interval while polling is warranted and `false` otherwise, so polling is
 * self-disabling and costs nothing at rest.
 *
 * `ExecutionStatus` has only RUNNING | SUCCESS | FAILED (no PENDING/QUEUED), so
 * "any row still RUNNING" is a complete non-terminal check.
 */
export const RUNNING_POLL_MS = 3000;

/**
 * How long the list keeps polling after it's opened or the tab is refocused,
 * even with no RUNNING row visible yet. This bridges the cold start: a run that
 * was just triggered (in this tab or another) can't be surfaced by a
 * data-driven interval, because the list hasn't fetched its row yet — and the
 * engine creates that row a beat after the trigger returns. Polling for a short
 * window on open/focus lets a brand-new run appear on its own instead of only
 * after a manual refresh.
 */
export const LIST_GRACE_MS = 15000;

/**
 * List view: keep polling while any row on the current page is still RUNNING,
 * or while inside the post-open/-focus grace window. `false` (stop) once neither
 * holds. `graceUntil` is an epoch-ms deadline (0 = no window); `now` is injected
 * for testing.
 */
export function executionsListRefetchInterval(
  data: { items: { status: ExecutionStatus }[] } | undefined,
  graceUntil = 0,
  now = Date.now(),
): number | false {
  const anyRunning =
    data?.items.some((e) => e.status === ExecutionStatus.RUNNING) ?? false;
  const inGraceWindow = now < graceUntil;
  return anyRunning || inGraceWindow ? RUNNING_POLL_MS : false;
}

/** Detail view: keep polling while this execution is still RUNNING. */
export function executionRefetchInterval(
  data: { status: ExecutionStatus } | undefined,
): number | false {
  return data?.status === ExecutionStatus.RUNNING ? RUNNING_POLL_MS : false;
}
