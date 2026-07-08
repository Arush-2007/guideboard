/**
 * Humanize a millisecond duration for the execution detail page — compact enough
 * for a node row, readable at a glance:
 *   340   -> "340ms"
 *   1200  -> "1.2s"      (trailing ".0" dropped, so 4000 -> "4s")
 *   65000 -> "1m 5s"
 *   120000 -> "2m"
 * Null/undefined/negative/non-finite collapse to an em dash so callers can pass a
 * possibly-missing `durationMs` (or a not-yet-completed run) without a guard.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  // Decide the branch on the *rounded* value, not the raw one: 59.96s would pass
  // `seconds < 60` yet display as "60.0s", so gate on what we'd actually print so
  // it promotes to "1m" instead of rendering a nonsensical "60s".
  const roundedSeconds = Number(seconds.toFixed(1));
  if (roundedSeconds < 60) return `${roundedSeconds}s`;
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
