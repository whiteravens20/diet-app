// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { WeightDay } from '@diet-app/shared';

/** Kilograms to the hundredth. */
const hundredths = (kg: number): number => Math.round(kg * 100) / 100;

/** The day a moment falls on in `timeZone`, as `2026-03-01`. */
export function dayIn(timeZone: string): (moment: Date) => string {
  const format = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (moment) => {
    const parts = format.formatToParts(moment);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((each) => each.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
}

/** The day `days` before `day`, both as `2026-03-01`. */
function daysBefore(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

/**
 * The weights of a profile as a chart draws them: one point a day, the last
 * entry of the day standing for it, oldest first, each with the mean of the
 * seven days of the calendar that end with it. A day is the one in
 * `timeZone`: an entry made late in the evening belongs to that evening, not
 * to the day it already is in UTC.
 */
export function weightDays(
  entries: readonly { kg: number; recordedAt: Date }[],
  timeZone: string,
): WeightDay[] {
  const dayOf = dayIn(timeZone);
  const byDay = new Map<string, { kg: number; recordedAt: Date }>();
  for (const entry of entries) {
    const day = dayOf(entry.recordedAt);
    const kept = byDay.get(day);
    if (!kept || kept.recordedAt < entry.recordedAt) byDay.set(day, entry);
  }
  // Dates in this form sort as text.
  const days = [...byDay.keys()].sort();
  return days.map((day) => {
    const from = daysBefore(day, 6);
    const week = days
      .filter((other) => other >= from && other <= day)
      .map((other) => byDay.get(other)!.kg);
    return {
      date: day,
      kg: hundredths(byDay.get(day)!.kg),
      mean: hundredths(week.reduce((sum, kg) => sum + kg, 0) / week.length),
    };
  });
}
