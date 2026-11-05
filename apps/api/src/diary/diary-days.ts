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
 * holds an entry, by date: one statement for all of them. A day of a plan
 * counts it as eaten, wherever the day is worked out.
 */
export async function diaryDays(
  db: Pick<Prisma.TransactionClient, 'diaryEntry'>,
  profileId: string,
  from: Date,
  to: Date,
): Promise<Map<string, DiaryOnDay>> {
  const where = { profileId, date: { gte: from, lte: to } };
  const days = await db.diaryEntry.groupBy({
    by: ['date'],
    where,
    _count: { _all: true },
    _sum: { calories: true, protein: true, fat: true, carbs: true },
  });
  // A sum leaves out what an entry does not know, and a day has to say that it does not: the four
  // of every entry, which a day holds at most `MAX_DIARY_ENTRIES_A_DAY` of.
  const labels = new Map<string, LabelTotals[]>();
  for (const entry of await db.diaryEntry.findMany({
    where,
    select: {
      date: true,
      fiber: true,
      sugars: true,
      salt: true,
      saturatedFat: true,
      labelAtLeast: true,
    },
  })) {
    const date = isoDate(entry.date);
    labels.set(date, [...(labels.get(date) ?? []), fromStoredLabel(entry)]);
  }
  return new Map(
    days.map((day) => [
      isoDate(day.date),
      {
        entries: day._count._all,
        nutrition: wholeFigures({
          calories: day._sum.calories ?? 0,
          protein: day._sum.protein ?? 0,
          fat: day._sum.fat ?? 0,
          carbs: day._sum.carbs ?? 0,
        }),
        label: roundLabel(sumLabels(labels.get(isoDate(day.date)) ?? [])),
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
