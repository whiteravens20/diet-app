// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Profile } from '@prisma/client';
import {
  dayAfter,
  EXPENDITURE_DAYS,
  EXPENDITURE_EVERY_DAYS,
  EXPENDITURE_LATER_DAYS,
  EXPENDITURE_LEAST_DAYS,
  EXPENDITURE_LEAST_DIFFERENCE,
  EXPENDITURE_LEAST_SHARE_OF_TARGET,
  EXPENDITURE_LEAST_SPAN_DAYS,
  EXPENDITURE_LEAST_WEIGHTS,
  EXPENDITURE_MOST_SHARE,
  TREND_DAYS,
  TREND_LEAST_SPAN_DAYS,
  TREND_LEAST_WEIGHTS,
  WEEK_DAYS,
  WITHIN_TARGET_SHARE,
  type Expenditure,
  type Nutrition,
  type WeekSummary,
  type WeekWater,
  type WeightTrend,
} from '@diet-app/shared';
import {
  calculateBmr,
  calculateCalories,
  calculateMaintenance,
  KCAL_PER_KG_FAT,
} from '../engine/nutrition.js';
import { isoDate } from '../meal-plans/plan-days.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calorieInputOf } from '../profiles/calorie-input.js';
import { DiaryService, type DayFigures } from './diary.service.js';
import { weightLine, type WeightPoint } from './weight-line.js';

const DAY_MS = 86_400_000;

/** How far ahead a trend is said to reach a target weight: further than this, it is not in sight. */
const FURTHEST_DAYS_AHEAD = 730;

/** What one working out of the real expenditure came to. */
interface Check {
  estimate: number | null;
  days: number;
  weights: number;
  checkedOn: string;
}

/** The days since 1970 of a calendar day, as the line is fitted in. */
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/** A whole of ten, as targets are kept. */
const tens = (kcal: number): number => Math.round(kcal / 10) * 10;

/**
 * What a profile's diary and weights come to over time: the week in sum, and
 * the real expenditure, from which a corrected target is proposed and never
 * applied unasked.
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
      water: await this.water(profileId, from, end),
      weight: await this.trend(profileId, end),
    };
  }

  /** What the days from `from` to `end` drank: the days that hold water, their average, and those that reached the target. */
  private async water(profileId: string, from: string, end: string): Promise<WeekWater> {
    const [days, profile] = await Promise.all([
      this.prisma.waterEntry.groupBy({
        by: ['day'],
        where: { profileId, day: { gte: new Date(from), lte: new Date(end) } },
        _sum: { ml: true },
      }),
      this.prisma.profile.findUnique({ where: { id: profileId }, select: { waterTargetMl: true } }),
    ]);
    const held = days.map((day) => day._sum.ml ?? 0).filter((ml) => ml > 0);
    const target = profile?.waterTargetMl ?? null;
    return {
      counted: held.length,
      averageMl: held.length ? Math.round(held.reduce((a, b) => a + b, 0) / held.length) : null,
      target,
      reached: target === null ? 0 : held.filter((ml) => ml >= target).length,
    };
  }

  /**
   * The real expenditure of a profile, worked out again once a week from the
   * three weeks of diary and weights before the client's day: what is too
   * little to go by, near the formula, proposed, put off or kept.
   */
  async expenditure(userId: string, profileId: string, today: string | null): Promise<Expenditure> {
    const now = today ?? isoDate(new Date());
    let profile = await this.profile(userId, profileId);
    const checkedOn = profile.expenditureCheckedOn ? isoDate(profile.expenditureCheckedOn) : null;
    if (checkedOn === null || checkedOn <= dayAfter(now, -EXPENDITURE_EVERY_DAYS)) {
      const check = await this.workOut(userId, profileId, now);
      profile = await this.prisma.profile.update({
        where: { id: profileId },
        data: {
          expenditureEstimateKcal: check.estimate,
          expenditureDays: check.days,
          expenditureWeights: check.weights,
          expenditureCheckedOn: new Date(check.checkedOn),
        },
      });
    }
    return said(profile, now);
  }

  /** Take the correction proposed: the profile's target follows it from now on, a plan's at its next making. */
  async accept(userId: string, profileId: string, today: string | null): Promise<Expenditure> {
    const now = today ?? isoDate(new Date());
    const shown = await this.expenditure(userId, profileId, now);
    if (shown.state !== 'proposed' || shown.correction === null) {
      throw new ConflictException({
        error: 'EXPENDITURE_NOTHING_PROPOSED',
        message: 'No correction of the target is proposed for this profile now.',
      });
    }
    const profile = await this.prisma.profile.update({
      where: { id: profileId },
      data: { expenditureCorrectionKcal: shown.correction, expenditureLaterUntil: null },
    });
    return said(profile, now);
  }

  /** Put a proposal off for two weeks ("Nie teraz"). */
  async later(userId: string, profileId: string, today: string | null): Promise<Expenditure> {
    const now = today ?? isoDate(new Date());
    await this.expenditure(userId, profileId, now);
    const profile = await this.prisma.profile.update({
      where: { id: profileId },
      data: { expenditureLaterUntil: new Date(dayAfter(now, EXPENDITURE_LATER_DAYS)) },
    });
    return said(profile, now);
  }

  /**
   * Take a kept correction away: the target is the formula's again, and no
   * proposal comes back for two weeks, as after "Nie teraz".
   */
  async drop(userId: string, profileId: string, today: string | null): Promise<Expenditure> {
    const now = today ?? isoDate(new Date());
    await this.profile(userId, profileId);
    const profile = await this.prisma.profile.update({
      where: { id: profileId },
      data: {
        expenditureCorrectionKcal: null,
        expenditureLaterUntil: new Date(dayAfter(now, EXPENDITURE_LATER_DAYS)),
      },
    });
    return said(profile, now);
  }

  /**
   * One working out over the 21 days before `now`: the average eaten on the
   * days that count, each with at least half its target (a day written in
   * half would make the body seem to use less than it does), less the change
   * of the fitted weight in energy, 7700 kcal a kilogram.
   */
  private async workOut(userId: string, profileId: string, now: string): Promise<Check> {
    const end = dayAfter(now, -1);
    const from = dayAfter(end, -(EXPENDITURE_DAYS - 1));
    const [days, weights] = await Promise.all([
      this.diary.figuresOfDays(userId, profileId, from, end),
      this.weights(profileId, from, end),
    ]);
    const counted = days.filter(
      (day) =>
        day.counted &&
        day.eaten.calories >= EXPENDITURE_LEAST_SHARE_OF_TARGET * day.target.calories,
    );
    const line = spans(weights, EXPENDITURE_LEAST_SPAN_DAYS) ? weightLine(weights) : null;
    const enough =
      counted.length >= EXPENDITURE_LEAST_DAYS && weights.length >= EXPENDITURE_LEAST_WEIGHTS;
    const eaten = counted.reduce((sum, day) => sum + day.eaten.calories, 0) / (counted.length || 1);
    return {
      estimate: enough && line ? tens(eaten - line.perDay * KCAL_PER_KG_FAT) : null,
      days: counted.length,
      weights: weights.length,
      checkedOn: now,
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

  private async profile(userId: string, profileId: string): Promise<Profile> {
    const profile = await this.prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile || profile.userId !== userId)
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    return profile;
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

/** What the last working out says of a profile now: a correction kept, or what it would be. */
function said(profile: Profile, now: string): Expenditure {
  const input = calorieInputOf(profile);
  const maintenance = calculateMaintenance(calculateBmr(input), input.activityLevel);
  const target = calculateCalories(input).dailyTarget;
  const base = {
    days: profile.expenditureDays ?? 0,
    weights: profile.expenditureWeights ?? 0,
    estimate: profile.expenditureEstimateKcal,
    maintenance,
    target,
    checkedOn: profile.expenditureCheckedOn ? isoDate(profile.expenditureCheckedOn) : null,
    laterUntil: profile.expenditureLaterUntil ? isoDate(profile.expenditureLaterUntil) : null,
  };
  if (profile.expenditureCorrectionKcal !== null) {
    return {
      ...base,
      state: 'kept',
      correction: profile.expenditureCorrectionKcal,
      targetCorrected: null,
    };
  }
  if (profile.expenditureEstimateKcal === null) {
    return { ...base, state: 'too_little', correction: null, targetCorrected: null };
  }
  const most = maintenance * EXPENDITURE_MOST_SHARE;
  const correction = tens(
    Math.max(-most, Math.min(most, profile.expenditureEstimateKcal - maintenance)),
  );
  if (Math.abs(correction) < EXPENDITURE_LEAST_DIFFERENCE) {
    return { ...base, state: 'near', correction: null, targetCorrected: null };
  }
  if (base.laterUntil !== null && base.laterUntil > now) {
    return { ...base, state: 'later', correction, targetCorrected: null };
  }
  const targetCorrected = calculateCalories({
    ...input,
    expenditureCorrection: correction,
  }).dailyTarget;
  return { ...base, state: 'proposed', correction, targetCorrected };
}
