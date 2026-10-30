// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import { isoDate } from '../meal-plans/plan-days.js';

/** Energy and the three macronutrients, in kcal and grams. */
interface Amounts {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

/** What a profile's diary holds for a day: how many entries, and what they come to, in whole kcal and grams. */
export interface DiaryOnDay {
  entries: number;
  nutrition: Amounts;
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
  const days = await db.diaryEntry.groupBy({
    by: ['date'],
    where: { profileId, date: { gte: from, lte: to } },
    _count: { _all: true },
    _sum: { calories: true, protein: true, fat: true, carbs: true },
  });
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
      },
    ]),
  );
}
