// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';
import { CalendarDay } from './enums.js';
import { Nutrition } from './nutrition.js';

/** The days of a week in sum: the full days before today, today left out. */
export const WEEK_DAYS = 7;

/** A day that counts comes within this share of its target to be "on target". */
export const WITHIN_TARGET_SHARE = 0.1;

/** The days whose weights the trend of a week is fitted to, the least weights it needs, and the least days they span. */
export const TREND_DAYS = 28;
export const TREND_LEAST_WEIGHTS = 3;
export const TREND_LEAST_SPAN_DAYS = 14;

/** What the week in sum asks for (`GET /diary/week`): the seven days that end with `to`, yesterday where it names none. */
export const WeekSummaryQuery = z.object({
  profileId: z.string().uuid(),
  to: CalendarDay.optional(),
});
export type WeekSummaryQuery = z.infer<typeof WeekSummaryQuery>;

/** Where the weights of a profile lead: the fitted line's pace, and the day it reaches the target weight. */
export const WeightTrend = z.object({
  /** The line's change in kilograms a week; null without three weights spanning 14 of the last 28 days. */
  kgPerWeek: z.number().nullable(),
  /** The weight the profile works towards; null where it names none. */
  targetKg: z.number().nullable(),
  /** The day the line reaches the target weight at this pace; null where the line is flat or leads away from it. */
  reachesTargetOn: CalendarDay.nullable(),
});
export type WeightTrend = z.infer<typeof WeightTrend>;

/** A week of a profile in sum: what its days ate against what they aimed at, and where its weight leads. */
export const WeekSummary = z.object({
  from: CalendarDay,
  to: CalendarDay,
  /** The days with an entry or a meal of a plan marked eaten, and those with neither, which no average counts. */
  counted: z.number().int().min(0).max(WEEK_DAYS),
  empty: z.number().int().min(0).max(WEEK_DAYS),
  /** The average of the days that count; null where none does. */
  eaten: Nutrition.nullable(),
  target: Nutrition.nullable(),
  /** The days that count which came within a tenth of their target. */
  withinTarget: z.number().int().min(0).max(WEEK_DAYS),
  weight: WeightTrend,
});
export type WeekSummary = z.infer<typeof WeekSummary>;
