// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** The days of a plan that begins on `startDate` and is `durationDays` long, as `2026-03-01`. */
export function planDates(startDate: string, durationDays: number): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || durationDays < 1) return [];
  return Array.from({ length: Math.min(durationDays, 28) }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** The first day of the month a calendar day lies in. */
export function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The first day of the month that comes `months` after the month of `day`, or before it when `months` is negative. */
export function monthAfter(day: string, months: number): string {
  const first = new Date(`${monthOf(day)}T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() + months);
  return first.toISOString().slice(0, 10);
}

/**
 * The weeks a month is drawn in, Monday first: every day from the Monday on
 * or before its first day to the Sunday on or after its last. That is four
 * to six weeks, and so never more days than a calendar of plans is asked for
 * at once.
 */
export function weeksOf(month: string): string[][] {
  const first = new Date(`${monthOf(month)}T00:00:00Z`);
  const next = new Date(`${monthAfter(month, 1)}T00:00:00Z`);
  const day = new Date(first);
  // getUTCDay counts from Sunday; a week here begins on Monday.
  day.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
  const weeks: string[][] = [];
  while (day < next) {
    const week: string[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      week.push(day.toISOString().slice(0, 10));
      day.setUTCDate(day.getUTCDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}
