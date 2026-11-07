// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';
import { WEEK_DAYS } from './constants.js';
import { CalendarDay } from './enums.js';
import { Nutrition } from './nutrition.js';

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

/** The days the real expenditure is worked out from, the least of them that count, and what a day needs of its target to count. */
export const EXPENDITURE_DAYS = 21;
export const EXPENDITURE_LEAST_DAYS = 14;
export const EXPENDITURE_LEAST_SHARE_OF_TARGET = 0.5;
/** The least weights over those days, and the least days they span. */
export const EXPENDITURE_LEAST_WEIGHTS = 4;
export const EXPENDITURE_LEAST_SPAN_DAYS = 14;
/** The least difference from the formula a proposal is made for, in kcal a day, and the most a correction is, as a share of the formula's maintenance. */
export const EXPENDITURE_LEAST_DIFFERENCE = 100;
export const EXPENDITURE_MOST_SHARE = 0.25;
/** How often the expenditure is worked out again, and how long "Nie teraz" puts a proposal off, in days. */
export const EXPENDITURE_EVERY_DAYS = 7;
export const EXPENDITURE_LATER_DAYS = 14;

/** The profile whose real expenditure is asked for, or acted on. */
export const ExpenditureRequest = z.object({ profileId: z.string().uuid() });
export type ExpenditureRequest = z.infer<typeof ExpenditureRequest>;

/**
 * What the diary and the weights say of what a profile really uses
 * (`GET /diary/expenditure`), worked out once a week: too little of them yet,
 * an expenditure near the formula's, a correction proposed, a proposal put off,
 * or a correction kept. A correction is only ever kept when it is accepted.
 */
export const Expenditure = z.object({
  state: z.enum(['too_little', 'near', 'proposed', 'later', 'kept']),
  /** What the last working out counted: the days that count and the weights. */
  days: z.number().int().min(0),
  weights: z.number().int().min(0),
  /** The expenditure worked out, in kcal a day; null with too little to go by. */
  estimate: z.number().int().nullable(),
  /** The formula's maintenance, with no correction. */
  maintenance: z.number().int(),
  /** The correction proposed or kept, in kcal a day against the formula; null where there is none. */
  correction: z.number().int().nullable(),
  /** The daily target as it stands, and as it would with the correction proposed. */
  target: z.number().int(),
  targetCorrected: z.number().int().nullable(),
  /** The day it was last worked out, and the day a proposal put off comes back. */
  checkedOn: CalendarDay.nullable(),
  laterUntil: CalendarDay.nullable(),
});
export type Expenditure = z.infer<typeof Expenditure>;
