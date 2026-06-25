import prisma from "@/lib/db";
import { computeNextRunAt } from "@/lib/schedule";
import { sendWorkflowExecution } from "./utils";

/**
 * Processes a single due `SchedulePoll`: dispatches the workflow for the slot
 * that came due, then advances `nextRunAt` to the next firing.
 *
 * Extracted from the Inngest handler (the same way `run-workflow.ts` holds the
 * engine core out of `executeWorkflow`) so it can be driven directly by an
 * integration test without an Inngest runtime. `handleSchedulePoll` wraps this
 * in a single `step.run`.
 *
 * Double-fire safety:
 *  - The `schedule:<pollId>:<scheduledISO>` idempotency key dedups the run at
 *    `executeWorkflow` if two overlapping ticks dispatch the same slot.
 *  - `nextRunAt` is recomputed from *now*, not from the due slot, so a backlog
 *    (e.g. the poller was down) collapses to a single catch-up run instead of
 *    replaying every missed minute.
 */
export async function processSchedulePoll(
  pollId: string,
  now: Date = new Date(),
): Promise<{ dispatched: boolean }> {
  const poll = await prisma.schedulePoll.findUnique({
    where: { id: pollId },
    select: {
      id: true,
      workflowId: true,
      cron: true,
      timezone: true,
      nextRunAt: true,
    },
  });
  if (!poll) return { dispatched: false };

  // Guard against a stale fan-out: only fire if the row is actually due. The
  // dispatcher selects due rows, but a row could have advanced between the scan
  // and this handler (a duplicate event, a retry after the update committed).
  if (poll.nextRunAt.getTime() > now.getTime()) {
    return { dispatched: false };
  }

  const scheduledAt = poll.nextRunAt;

  await sendWorkflowExecution({
    workflowId: poll.workflowId,
    initialData: { schedule: { scheduledAt: scheduledAt.toISOString() } },
    idempotencyKey: `schedule:${poll.id}:${scheduledAt.toISOString()}`,
  });

  const nextRunAt = computeNextRunAt(poll.cron, poll.timezone, now);
  await prisma.schedulePoll.update({
    where: { id: poll.id },
    data: { lastRunAt: scheduledAt, nextRunAt },
  });

  return { dispatched: true };
}
