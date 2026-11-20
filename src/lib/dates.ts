/** Local-calendar helpers. Dates are compared by local day, not by time of day. */

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDaysLocal(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Whole local days from `start` to `now` (0 when they are the same day). */
export function daysSince(start: Date, now: Date): number {
  return Math.round((startOfDay(now).getTime() - startOfDay(start).getTime()) / 86400000);
}

/**
 * The day the user started using the service (account creation). Falls back to today when
 * unknown, and never goes past today.
 */
export function serviceStartDate(createdAt: string | null | undefined, now: Date = new Date()): Date {
  const today = startOfDay(now);
  if (!createdAt) return today;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return today;
  const start = startOfDay(d);
  return start > today ? today : start;
}
