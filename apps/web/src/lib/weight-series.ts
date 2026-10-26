// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { WeightEntry } from '@diet-app/shared';
import { localDate } from './http';

export interface WeightPoint {
  /** The day of the entry, by the reader's clock: `2026-03-01`. */
  date: string;
  /** What was logged that day, the last entry of it when there are several. */
  kg: number;
  /** The mean of what was logged in the seven days that end with this one. */
  ma7: number;
}

const hundredths = (kg: number): number => Math.round(kg * 100) / 100;

/** The day `days` before `day`, both as `2026-03-01`. */
function daysBefore(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

/**
 * The weights of a profile as a chart draws them: one point a day (the last
 * entry of the day), oldest first, each with the mean of the seven days that
 * end with it. The seven days are days of the calendar, not the last seven
 * entries: somebody who steps on the scales once a week has a mean of one
 * entry, not of seven weeks. A day is the reader's own: an entry made late in
 * the evening belongs to that evening, not to the day it already is in UTC.
 */
export function weightSeries(entries: readonly WeightEntry[]): WeightPoint[] {
  const byDay = new Map<string, WeightEntry>();
  for (const entry of entries) {
    const day = localDate(new Date(entry.recordedAt));
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
      ma7: hundredths(week.reduce((sum, kg) => sum + kg, 0) / week.length),
    };
  });
}
