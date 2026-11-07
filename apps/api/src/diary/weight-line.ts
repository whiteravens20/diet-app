// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** A weight at a moment: the days since some start, and the kilograms. */
export interface WeightPoint {
  day: number;
  kg: number;
}

/** A straight line fitted to weights: its change a day, and its value on a day. */
export interface WeightLine {
  perDay: number;
  at: (day: number) => number;
}

/**
 * The straight line that weights lie closest to, by least squares: one
 * weighing moves it little, as water moves a body by a kilogram or two from
 * one day to the next. Null for fewer than two points or points of one day,
 * through which no slope can be drawn.
 */
export function weightLine(points: readonly WeightPoint[]): WeightLine | null {
  if (points.length < 2) return null;
  const n = points.length;
  const meanDay = points.reduce((sum, point) => sum + point.day, 0) / n;
  const meanKg = points.reduce((sum, point) => sum + point.kg, 0) / n;
  const spread = points.reduce((sum, point) => sum + (point.day - meanDay) ** 2, 0);
  if (spread === 0) return null;
  const perDay =
    points.reduce((sum, point) => sum + (point.day - meanDay) * (point.kg - meanKg), 0) / spread;
  return { perDay, at: (day) => meanKg + perDay * (day - meanDay) };
}
