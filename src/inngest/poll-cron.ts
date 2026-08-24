import { logger } from "@/lib/logger";

/**
 * How often the database-backed pollers wake up.
 *
 * `pollTriggers` and `pollSchedules` share this ONE value, and the sharing is
 * the point rather than a tidiness choice.
 *
 * Both pollers query Postgres on every tick whether or not anything is due, so
 * between them they decide how often the database is touched by an idle
 * install. A serverless Postgres (Neon, and every comparable service) suspends
 * its compute after a fixed idle window — five minutes on Neon — and bills for
 * every minute it is awake. So the cost of a poll is not the query: it is the
 * five idle minutes the query resets. Two pollers on DIFFERENT intervals
 * interleave their wake-ups and can keep the compute alive continuously even
 * where each alone would let it sleep — every-10 and every-15 together fire at
 * :00 :10 :15 :20 :30 :40 :45 :50, eight wake-ups an hour to do the work of
 * six. Aligned on one interval they fire together and cost one.
 *
 * That is not hypothetical here. Running these at every-minute and every-5
 * meant the compute never once suspended, which exhausted a month's compute
 * allowance around day 20 and took the production database — and with it
 * sign-in, workflows and webhooks — offline until the quota reset.
 *
 * ## Choosing a value
 *
 * The budget is `awake hours = wake-ups per month x (idle window + query time)`.
 * At a five-minute idle window each wake-up costs ~5.1 minutes of billed
 * compute, so across a 730-hour month:
 *
 * | interval   | wake-ups/hour | compute awake | fits a 400-hour budget? |
 * |------------|---------------|---------------|-------------------------|
 * | every 5 m  | 12            | always        | no                      |
 * | every 10 m | 6             | ~51%  (372 h) | barely, no headroom     |
 * | every 15 m | 4             | ~34%  (248 h) | yes                     |
 * | every 30 m | 2             | ~17%  (124 h) | comfortably             |
 *
 * The default is every 15 minutes: it leaves room for real traffic (every page
 * view wakes the compute too) while keeping schedules usefully prompt. A
 * deployment on provisioned Postgres, or on a plan with no autosuspend to
 * protect, has no reason to stay here — set `POLL_CRON` as low as it can
 * afford.
 *
 * ## What it costs
 *
 * This interval caps granularity in both directions: a SCHEDULE_TRIGGER fires
 * only as precisely as the poll that finds it, and a Gmail/Sheets/YouTube
 * trigger sees new data only as promptly. At every 15 minutes a schedule set
 * for 09:07 runs at 09:15.
 *
 * For a schedule COARSER than this interval that is the whole story — late, but
 * every slot delivered. For a FINER one it is not: `processSchedulePoll`
 * recomputes `nextRunAt` from now rather than from the slot it fired, so a
 * five-minute cron under a 15-minute poll delivers about 4 of its 12 hourly
 * slots and drops the rest. Slots are SKIPPED, not queued. The schedule dialog
 * says so at configuration time (`scheduleUnderFires`, `src/lib/schedule.ts`);
 * this comment used to claim nothing was ever missed, which held only for the
 * coarse case.
 *
 * The polling triggers carry their own version of the trade: Gmail lists at
 * most 10 unread messages per tick and YouTube 50 comments, neither paginated,
 * so a longer interval is also a smaller share of a busy source per tick.
 */
export const DEFAULT_POLL_CRON = "*/15 * * * *";

/**
 * Whether a string is shaped like a cron expression Inngest will accept: five
 * whitespace-separated fields, after an optional `TZ=<zone>` prefix.
 *
 * The quote check is not decoration. Vercel stores an environment value
 * literally, so a value pasted WITH the quotes `.env.example` writes it in
 * arrives as a five-field string that merely begins and ends with a quote — it
 * passed a field count alone, reached `createFunction`, and took the whole
 * serve() handler down with it. That is precisely the outage this function
 * exists to prevent, so the check has to cover it.
 *
 * A shape check, not a parse — it catches the realistic typo (four fields,
 * quotes, prose) and does not pretend to validate field contents.
 */
function isCronShaped(value: string): boolean {
  if (/["']/.test(value)) return false;
  const withoutTimezone = value.replace(/^TZ=\S+\s+/, "");
  return withoutTimezone.split(/\s+/).filter(Boolean).length === 5;
}

/**
 * The configured interval, or the default when the override is absent or
 * unusable.
 *
 * Falling back rather than throwing is deliberate, and so is being noisy about
 * it. Every Inngest function is registered through the single `serve()` handler
 * in `app/api/inngest/route.ts`, so ONE malformed cron does not merely break
 * polling — it takes `executeWorkflow` and every other function down with it. A
 * typo in an optional tuning knob must not be able to do that.
 *
 * `?.trim() ||`, not `??`: setting an env var to an empty value is the ordinary
 * way to unset one, and `??` only falls back on `undefined`, so `""` (or a
 * couple of spaces) would otherwise reach `createFunction` as an invalid cron.
 */
export function resolvePollCron(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) return DEFAULT_POLL_CRON;

  if (!isCronShaped(configured)) {
    logger.error(
      "POLL_CRON is not a valid cron expression; using the default",
      { configured, using: DEFAULT_POLL_CRON },
    );
    return DEFAULT_POLL_CRON;
  }

  return configured;
}

/** Resolved once at module load — `createFunction` needs a literal at import. */
export const POLL_CRON = resolvePollCron(process.env.POLL_CRON);

// `SCHEDULE_POLL_CRON` drove the schedule poller before both pollers were put on
// one interval. A deployment that had deliberately set it (DEPLOYMENT.md used to
// instruct exactly that) would otherwise have its granularity changed by an
// upgrade with nothing said, so say it once at boot rather than leave the only
// trace in a checklist item.
if (process.env.SCHEDULE_POLL_CRON?.trim()) {
  logger.warn(
    "SCHEDULE_POLL_CRON is no longer read — both pollers now share POLL_CRON. " +
      "Delete it, and set POLL_CRON if you need a non-default interval.",
    { ignored: process.env.SCHEDULE_POLL_CRON, using: POLL_CRON },
  );
}
