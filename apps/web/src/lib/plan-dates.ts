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
