// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import {
  dayAfter,
  TREND_DAYS,
  TREND_LEAST_SPAN_DAYS,
  TREND_LEAST_WEIGHTS,
  WEEK_DAYS,
  WITHIN_TARGET_SHARE,
  type Nutrition,
  type WeekSummary,
  type WeightTrend,
} from '@diet-app/shared';
import { isoDate } from '../meal-plans/plan-days.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DiaryService, type DayFigures } from './diary.service.js';
import { weightLine, type WeightPoint } from './weight-line.js';

const DAY_MS = 86_400_000;

/** How far ahead a trend is said to reach a target weight: further than this, it is not in sight. */
const FURTHEST_DAYS_AHEAD = 730;

/** The days since 1970 of a calendar day, as the line is fitted in. */
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/**
 * What a profile's diary and weights come to over time: the week in sum.
 */
@Injectable()
export class DiarySummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly diary: DiaryService,
  ) {}

  /**
   * The seven days that end with `to` (yesterday by the client's day where it
   * names none): what the days that count ate on average against what they
   * aimed at, how many came within a tenth of it, and where the weight leads.
   */
  async week(
    userId: string,
    profileId: string,
    to: string | undefined,
    today: string | null,
  ): Promise<WeekSummary> {
    const end = to ?? dayAfter(today ?? isoDate(new Date()), -1);
    const from = dayAfter(end, -(WEEK_DAYS - 1));
    const days = await this.diary.figuresOfDays(userId, profileId, from, end);
    const counted = days.filter((day) => day.counted);
    return {
      from,
      to: end,
      counted: counted.length,
      empty: days.length - counted.length,
      eaten: average(counted.map((day) => day.eaten)),
      target: average(counted.map((day) => day.target)),
      withinTarget: counted.filter(
        (day) =>
          Math.abs(day.eaten.calories - day.target.calories) <=
          WITHIN_TARGET_SHARE * day.target.calories,
      ).length,
      weight: await this.trend(profileId, end),
    };
  }

  /** Where a profile's weights of the 28 days that end with `end` lead. */
  private async trend(profileId: string, end: string): Promise<WeightTrend> {
    const from = dayAfter(end, -(TREND_DAYS - 1));
    const [weights, profile] = await Promise.all([
      this.weights(profileId, from, end),
      this.prisma.profile.findUnique({
        where: { id: profileId },
        select: { targetWeightKg: true },
      }),
    ]);
    const targetKg = profile?.targetWeightKg ?? null;
    const line =
      weights.length >= TREND_LEAST_WEIGHTS && spans(weights, TREND_LEAST_SPAN_DAYS)
        ? weightLine(weights)
        : null;
    if (!line) return { kgPerWeek: null, targetKg, reachesTargetOn: null };
    const kgPerWeek = Math.round(line.perDay * 7 * 100) / 100;
    let reachesTargetOn: string | null = null;
    if (targetKg !== null && kgPerWeek !== 0) {
      const ahead = (targetKg - line.at(dayNumber(end))) / line.perDay;
      if (ahead > 0 && ahead <= FURTHEST_DAYS_AHEAD)
        reachesTargetOn = dayAfter(end, Math.ceil(ahead));
    }
    return { kgPerWeek, targetKg, reachesTargetOn };
  }

  /** The weights noted on the days from `from` to `end`, by their day. */
  private async weights(profileId: string, from: string, end: string): Promise<WeightPoint[]> {
    const rows = await this.prisma.weightEntry.findMany({
      where: {
        profileId,
        recordedAt: { gte: new Date(from), lt: new Date(dayAfter(end, 1)) },
      },
      select: { kg: true, recordedAt: true },
      orderBy: { recordedAt: 'asc' },
    });
    return rows.map((row) => ({ day: row.recordedAt.getTime() / DAY_MS, kg: row.kg }));
  }
}

/** Whether weights span at least so many days, first to last. */
function spans(weights: readonly WeightPoint[], days: number): boolean {
  return weights.length > 1 && weights[weights.length - 1]!.day - weights[0]!.day >= days;
}

/** The average of days' figures, to whole kcal and grams; null for no days. */
function average(figures: readonly DayFigures['eaten'][]): Nutrition | null {
  if (figures.length === 0) return null;
  const mean = (key: keyof Nutrition) =>
    Math.round(figures.reduce((sum, day) => sum + day[key], 0) / figures.length);
  return {
    calories: mean('calories'),
    protein: mean('protein'),
    fat: mean('fat'),
    carbs: mean('carbs'),
  };
}
