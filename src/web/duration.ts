/**
 * A duration at the coarsest unit that still says something: seconds under a
 * minute, whole minutes under an hour, then hours and minutes.
 *
 * `TurnGroup.formatWorkDuration` is deliberately not this: a turn is often
 * under a second, so it carries sub-second precision this would round away to
 * "0s".
 */
export function formatCoarseDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
