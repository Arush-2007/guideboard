import z from "zod";
import { computeNextRunAt, isValidSchedule } from "@/lib/schedule";
import { createTRPCRouter, protectedProcedure } from "@/trpc/init";

/**
 * Schedule trigger support endpoints. `preview` validates a cron+timezone and
 * resolves the next couple of firing times so the editor dialog can show an
 * authoritative "next run" — computed by the SAME `src/lib/schedule.ts` the
 * poll engine fires on, instead of re-implementing cron math (or bundling
 * `cron-parser`) on the client.
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
      };
    }),
});
