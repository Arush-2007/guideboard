import z from "zod";
import { POLL_CRON } from "@/inngest/poll-cron";
import {
  computeNextRunAt,
  isValidSchedule,
  scheduleUnderFires,
} from "@/lib/schedule";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

/**
 * Schedule trigger support endpoints. `preview` validates a cron+timezone and
 * resolves the next couple of firing times so the editor dialog can show an
 * authoritative "next run" — computed by the SAME `src/lib/schedule.ts` the
 * poll engine fires on, instead of re-implementing cron math (or bundling
 * `cron-parser`) on the client.
 *
 * It also answers whether the schedule is finer than the poll that has to find
 * it. That combination silently DROPS slots rather than delaying them (see
 * `scheduleUnderFires`), and configuration time is the only moment the user can
 * act on it — afterwards the only symptom is a run history that is quietly
 * shorter than expected.
 */
export const scheduleRouter = createTRPCRouter({
  preview: protectedProcedure
    .input(z.object({ cron: z.string(), timezone: z.string() }))
    .query(({ input }) => {
      if (!isValidSchedule(input.cron, input.timezone)) {
        return { valid: false as const };
      }
      const next = computeNextRunAt(input.cron, input.timezone);
      const following = computeNextRunAt(input.cron, input.timezone, next);
      return {
        valid: true as const,
        next: next.toISOString(),
        following: following.toISOString(),
        // null in the ordinary case — the schedule is no finer than the poll.
        underFires: scheduleUnderFires(input.cron, input.timezone, POLL_CRON),
      };
    }),
});
