// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import type { LabelTotals } from '@diet-app/shared';
import { fromStoredLabel, roundLabel, sumLabels } from '../engine/label-totals.js';
import { isoDate } from '../meal-plans/plan-days.js';

/** Energy and the three macronutrients, in kcal and grams. */
interface Amounts {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

/**
 * What a profile's diary holds for a day: how many entries, what they come to, in whole kcal and
 * grams, and their fibre, sugars, salt and saturated fat, to a tenth of a gram.
 */
export interface DiaryOnDay {
  entries: number;
  nutrition: Amounts;
  label: LabelTotals;
}

/** Figures as a person reads them: whole kilocalories and grams. */
export function wholeFigures(figures: Amounts): Amounts {
  return {
    calories: Math.round(figures.calories),
    protein: Math.round(figures.protein),
    fat: Math.round(figures.fat),
    carbs: Math.round(figures.carbs),
  };
}

/**
 * What the diary of a profile holds for each day from `from` to `to` that
 * holds an entry, by date: one statement for all of them, whose rows are added
 * up here, as a sum of fibre, sugars, salt and saturated fat has to say what part
 * of it an entry does not know. A day holds `MAX_DIARY_ENTRIES_A_DAY` entries at
 * most. A day of a plan counts it as eaten, wherever the day is worked out.
 */
export async function diaryDays(
  db: Pick<Prisma.TransactionClient, 'diaryEntry'>,
  profileId: string,
  from: Date,
  to: Date,
): Promise<Map<string, DiaryOnDay>> {
  const entries = await db.diaryEntry.findMany({
    where: { profileId, date: { gte: from, lte: to } },
    select: {
      date: true,
      calories: true,
      protein: true,
      fat: true,
      carbs: true,
      fiber: true,
      sugars: true,
      salt: true,
      saturatedFat: true,
      labelAtLeast: true,
    },
  });
  const days = new Map<string, { entries: number; nutrition: Amounts; labels: LabelTotals[] }>();
  for (const entry of entries) {
    const date = isoDate(entry.date);
    const day = days.get(date) ?? {
      entries: 0,
      nutrition: { calories: 0, protein: 0, fat: 0, carbs: 0 },
      labels: [],
    };
    day.entries += 1;
    day.nutrition.calories += entry.calories;
    day.nutrition.protein += entry.protein;
    day.nutrition.fat += entry.fat;
    day.nutrition.carbs += entry.carbs;
    day.labels.push(fromStoredLabel(entry));
    days.set(date, day);
  }
  return new Map(
    [...days].map(([date, day]) => [
      date,
      {
        entries: day.entries,
        nutrition: wholeFigures(day.nutrition),
        label: roundLabel(sumLabels(day.labels)),
      },
    ]),
  );
}

/** The same for the days of a plan, in the order of their dates; nothing is asked for a plan without days. */
export function diaryOfDays(
  db: Pick<Prisma.TransactionClient, 'diaryEntry'>,
  profileId: string,
  days: readonly { date: Date }[],
): Promise<Map<string, DiaryOnDay>> {
  if (days.length === 0) return Promise.resolve(new Map());
  return diaryDays(db, profileId, days[0]!.date, days.at(-1)!.date);
}
