import { CronExpressionParser } from "cron-parser";

/**
 * Single source of truth for cron evaluation across the schedule trigger. The
 * sync hook (`syncTriggerPollsForWorkflow`), the poll engine
 * (`pollSchedules`/`handleSchedulePoll`), and the dialog's preview endpoint all
 * compute `nextRunAt` through here, so timezone/DST behaviour can never diverge
 * between "what we save", "what we fire", and "what we show the user".
 *
 * Cron strings are standard 5-field expressions (minute granularity).
 * Timezones are IANA names.
 *
 * A schedule fires only as often as the poll that finds it. `pollSchedules`
 * runs on `POLL_CRON` (`src/inngest/poll-cron.ts`), and `processSchedulePoll`
 * recomputes `nextRunAt` from NOW rather than from the slot it just fired — a
 * deliberate backlog collapse. Together those mean a cron FINER than the poll
 * interval does not merely run late, it silently skips slots: at a 15-minute
 * poll, a five-minute schedule fires about 4x an hour instead of 12.
 * `minIntervalMinutes`
 * below exists so the dialog can say so at configuration time instead of the
 * user discovering it from a run history that is quietly too short.
 */

/** True if `tz` is a timezone the runtime's Intl can resolve. */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** True if `cron` parses as a cron expression in `timezone` (both must be valid). */
export function isValidSchedule(cron: string, timezone: string): boolean {
  if (!isValidTimezone(timezone)) return false;
  try {
    CronExpressionParser.parse(cron, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The shortest gap, in whole minutes, between consecutive firings of `cron`.
 *
 * Sampled rather than reasoned about: cron fields interact (a five-minute step
 * under a restricted hour is not uniformly 5 minutes apart), so the honest
 * answer comes from asking for the next several firings and taking the smallest
 * gap. `SAMPLES` is enough to see one full minute-field cycle for every
 * expression the dialog can produce.
 *
 * Returns null when the expression does not parse, so callers can stay quiet
 * rather than guess — validity is `isValidSchedule`'s job, not this one's.
 */
export function minIntervalMinutes(
  cron: string,
  timezone: string,
): number | null {
  const SAMPLES = 12;
  try {
    const interval = CronExpressionParser.parse(cron, { tz: timezone });
    let previous = interval.next().toDate().getTime();
    let smallest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < SAMPLES; i++) {
      const current = interval.next().toDate().getTime();
      smallest = Math.min(smallest, (current - previous) / 60000);
      previous = current;
    }
    return Number.isFinite(smallest) ? Math.round(smallest) : null;
  } catch {
    return null;
  }
}

/**
 * How many of a schedule's slots the poller can actually deliver.
 *
 * `null` when either expression is unparseable, or when the schedule is no
 * finer than the poll — the ordinary case, nothing to report.
 */
export function scheduleUnderFires(
  cron: string,
  timezone: string,
  pollCron: string,
): { scheduleMinutes: number; pollMinutes: number } | null {
  const scheduleMinutes = minIntervalMinutes(cron, timezone);
  const pollMinutes = minIntervalMinutes(pollCron, "UTC");
  if (scheduleMinutes === null || pollMinutes === null) return null;
  if (scheduleMinutes >= pollMinutes) return null;
  return { scheduleMinutes, pollMinutes };
}

/**
 * The first firing strictly after `from` (default: now), as a UTC `Date`.
 * `cron-parser`'s `.next()` is exclusive of `currentDate`, so passing a prior
 * firing time as `from` correctly advances to the following occurrence.
 *
 * Throws if the cron/timezone is invalid; callers validate with
 * `isValidSchedule` before persisting, so the engine only ever sees good rows.
 */
export function computeNextRunAt(
  cron: string,
  timezone: string,
  from: Date = new Date(),
): Date {
  const interval = CronExpressionParser.parse(cron, {
    currentDate: from,
    tz: timezone,
  });
  return interval.next().toDate();
}
