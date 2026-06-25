/**
 * Client-safe schedule presets. Maps the dialog's friendly options
 * (Hourly / Daily / Weekly / Advanced) onto a standard 5-field cron string and
 * back, and renders a human description.
 *
 * Deliberately free of `cron-parser` (and any server-only import) so the editor
 * dialog can build the cron string to save — and round-trip a saved one back to
 * the right radio option — without pulling the timezone engine into the client
 * bundle. Actual firing-time math lives in `src/lib/schedule.ts` (server side).
 */

export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "custom"; cron: string };

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * A small curated list of common IANA timezones for the dialog's select. Not
 * exhaustive — the schema accepts any valid IANA name — but covers the usual
 * suspects, and the dialog defaults to the browser's resolved zone regardless.
 */
export const COMMON_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

const clampInt = (value: number, min: number, max: number): number => {
  const n = Math.trunc(Number.isFinite(value) ? value : min);
  return Math.min(max, Math.max(min, n));
};

/** Builds a 5-field cron string from a preset. */
export function buildCron(preset: SchedulePreset): string {
  switch (preset.kind) {
    case "hourly":
      return `${clampInt(preset.minute, 0, 59)} * * * *`;
    case "daily":
      return `${clampInt(preset.minute, 0, 59)} ${clampInt(preset.hour, 0, 23)} * * *`;
    case "weekly":
      return `${clampInt(preset.minute, 0, 59)} ${clampInt(preset.hour, 0, 23)} * * ${clampInt(preset.weekday, 0, 6)}`;
    case "custom":
      return preset.cron.trim();
  }
}

const isInt = (s: string): boolean => /^\d+$/.test(s);

/**
 * Best-effort inverse of `buildCron`: recognizes the exact shapes this module
 * emits and maps them back to a preset so reopening the dialog restores the
 * right radio option. Anything else (including hand-written advanced cron)
 * falls back to `{ kind: "custom" }`.
 */
export function cronToPreset(cron: string): SchedulePreset {
  const trimmed = cron.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    if (
      isInt(min) &&
      hour === "*" &&
      dom === "*" &&
      mon === "*" &&
      dow === "*"
    ) {
      return { kind: "hourly", minute: Number(min) };
    }
    if (
      isInt(min) &&
      isInt(hour) &&
      dom === "*" &&
      mon === "*" &&
      dow === "*"
    ) {
      return { kind: "daily", hour: Number(hour), minute: Number(min) };
    }
    if (isInt(min) && isInt(hour) && dom === "*" && mon === "*" && isInt(dow)) {
      return {
        kind: "weekly",
        weekday: Number(dow),
        hour: Number(hour),
        minute: Number(min),
      };
    }
  }
  return { kind: "custom", cron: trimmed };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Human-readable summary of a schedule, e.g. "Every day at 09:00 (UTC)". */
export function describeSchedule(
  preset: SchedulePreset,
  timezone: string,
): string {
  switch (preset.kind) {
    case "hourly":
      return `Every hour at :${pad(preset.minute)} (${timezone})`;
    case "daily":
      return `Every day at ${pad(preset.hour)}:${pad(preset.minute)} (${timezone})`;
    case "weekly":
      return `Every ${WEEKDAYS[preset.weekday] ?? "?"} at ${pad(preset.hour)}:${pad(preset.minute)} (${timezone})`;
    case "custom":
      return `Cron "${preset.cron}" (${timezone})`;
  }
}
