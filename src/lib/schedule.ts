import { CronExpressionParser } from "cron-parser";

/**
 * Single source of truth for cron evaluation across the schedule trigger. The
 * sync hook (`syncTriggerPollsForWorkflow`), the poll engine
 * (`pollSchedules`/`handleSchedulePoll`), and the dialog's preview endpoint all
 * compute `nextRunAt` through here, so timezone/DST behaviour can never diverge
 * between "what we save", "what we fire", and "what we show the user".
 *
 * Cron strings are standard 5-field expressions (minute granularity), matching
 * the per-minute `pollSchedules` cron. Timezones are IANA names.
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
