// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Prisma } from '@prisma/client';
import type { LabelTotals } from '@diet-app/shared';
import { fromStoredLabel, roundLabel, sumLabels } from '../engine/label-totals.js';
import { isoDate } from '../meal-plans/plan-days.js';
import { eatenMeals, type EatenMeal } from './eaten-meals.js';

/** Energy and the three macronutrients, in kcal and grams. */
interface Amounts {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

/**
 * What a profile ate on a day besides the meals of one of its plans: the entries of its diary, and
 * the meals marked eaten that day in its other plans (`otherPlans`). How many entries, and what all
 * of it comes to, in whole kcal and grams, and its fibre, sugars, salt and saturated fat, to a tenth
 * of a gram.
 */
export interface DiaryOnDay {
  entries: number;
  nutrition: Amounts;
  label: LabelTotals;
  otherPlans: EatenMeal[];
}

type Db = Pick<
  Prisma.TransactionClient,
  'plannedMeal' | 'mealPlanDay' | 'ingredient' | '$queryRaw'
>;

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
 * What a profile ate besides the meals of `planId` on each day from `from` to
 * `to` that holds any of it, by date: the entries of its diary, whose rows are
 * added up here, as a sum of fibre, sugars, salt and saturated fat has to say
 * what part of it an entry does not know, and the meals marked eaten in its
 * other plans (`eatenMeals`). A day of a plan counts it as eaten, wherever the
 * day is worked out: what was eaten counts whichever plan it came from. One
 * statement where no other plan had eaten anything in those days, which is
 * what nearly every profile has: a day is sized again many times in one
 * request.
 */
export async function diaryDays(
  db: Db,
  profileId: string,
  from: Date,
  to: Date,
  /** The plan the days are worked out for; null for a plan not written yet, beside which every plan counts. */
  planId: string | null,
): Promise<Map<string, DiaryOnDay>> {
  const besides = planId === null ? {} : { except: planId };
  const read = await readDiary(db, profileId, from, to, besides);
  return besidePlan(
    read.entries,
    read.eaten ? await eatenMeals(db, profileId, from, to, besides) : [],
  );
}

/** An entry of the diary as `readDiary` reads it: its day, its figures and its label. */
interface EntryRow {
  date: string;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  fiber: number | null;
  sugars: number | null;
  salt: number | null;
  saturatedFat: number | null;
  labelAtLeast: string[];
}

/**
 * A profile's entries from `from` to `to`, and whether a meal is marked eaten in those days in a plan of
 * it that counts: every plan but `except`, or, with `overlapping`, every plan on a day another plan holds
 * too. One statement.
 */
async function readDiary(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  profileId: string,
  from: Date,
  to: Date,
  besides: { except?: string; overlapping?: true },
): Promise<{ entries: EntryRow[]; eaten: boolean }> {
  const first = isoDate(from);
  const last = isoDate(to);
  const counted =
    besides.except !== undefined
      ? Prisma.sql`AND p."id" <> ${besides.except}`
      : besides.overlapping
        ? Prisma.sql`AND (SELECT COUNT(*) FROM "MealPlanDay" o JOIN "MealPlan" q ON q."id" = o."planId"
            WHERE q."profileId" = ${profileId} AND o."date" = d."date") > 1`
        : Prisma.empty;
  const [row] = await db.$queryRaw<{ entries: EntryRow[]; eaten: boolean }[]>`
    SELECT
      COALESCE((
        SELECT json_agg(json_build_object(
          'date', e."date", 'calories', e."calories", 'protein', e."protein", 'fat', e."fat",
          'carbs', e."carbs", 'fiber', e."fiber", 'sugars', e."sugars", 'salt', e."salt",
          'saturatedFat', e."saturatedFat", 'labelAtLeast', e."labelAtLeast"))
        FROM "DiaryEntry" e
        WHERE e."profileId" = ${profileId} AND e."date" >= ${first}::date AND e."date" <= ${last}::date
      ), '[]'::json) AS "entries",
      EXISTS (
        SELECT 1 FROM "PlannedMeal" m
        JOIN "MealPlanDay" d ON d."id" = m."dayId"
        JOIN "MealPlan" p ON p."id" = d."planId"
        WHERE p."profileId" = ${profileId} AND d."date" >= ${first}::date AND d."date" <= ${last}::date
          AND m."eatenAt" IS NOT NULL ${counted}
      ) AS "eaten"`;
  return row ?? { entries: [], eaten: false };
}

/** What the entries and the meals eaten elsewhere come to on each day that holds any of them. */
function besidePlan(
  written: readonly EntryRow[],
  eaten: readonly EatenMeal[],
): Map<string, DiaryOnDay> {
  const days = new Map<
    string,
    { entries: number; nutrition: Amounts; labels: LabelTotals[]; otherPlans: EatenMeal[] }
  >();
  const dayOf = (date: string) => {
    const day = days.get(date) ?? {
      entries: 0,
      nutrition: { calories: 0, protein: 0, fat: 0, carbs: 0 },
      labels: [],
      otherPlans: [],
    };
    days.set(date, day);
    return day;
  };
  for (const entry of written) {
    const day = dayOf(entry.date);
    day.entries += 1;
    day.nutrition.calories += entry.calories;
    day.nutrition.protein += entry.protein;
    day.nutrition.fat += entry.fat;
    day.nutrition.carbs += entry.carbs;
    day.labels.push(fromStoredLabel(entry));
  }
  // The entries are summed before they are rounded, as a day of the diary sums them; a meal is whole figures already.
  const rounded = new Map(
    [...days].map(([date, day]) => [date, wholeFigures(day.nutrition)] as const),
  );
  for (const meal of eaten) {
    const day = dayOf(meal.date);
    day.otherPlans.push(meal);
    day.labels.push(meal.label);
  }
  return new Map(
    [...days].map(([date, day]) => {
      const entered = rounded.get(date) ?? { calories: 0, protein: 0, fat: 0, carbs: 0 };
      const sum = (of: keyof Amounts) =>
        entered[of] + day.otherPlans.reduce((all, meal) => all + meal.nutrition[of], 0);
      return [
        date,
        {
          entries: day.entries,
          nutrition: {
            calories: sum('calories'),
            protein: sum('protein'),
            fat: sum('fat'),
            carbs: sum('carbs'),
          },
          label: roundLabel(sumLabels(day.labels)),
          otherPlans: day.otherPlans,
        },
      ];
    }),
  );
}

/** The same for the days of a plan, in the order of their dates; nothing is asked for a plan without days. */
export function diaryOfDays(
  db: Db,
  profileId: string,
  days: readonly { date: Date }[],
  planId: string | null,
): Promise<Map<string, DiaryOnDay>> {
  if (days.length === 0) return Promise.resolve(new Map());
  return diaryDays(db, profileId, days[0]!.date, days.at(-1)!.date, planId);
}

/**
 * The same for several plans of a profile at once, by plan: the entries are read once for the days of all
 * of them, the meals eaten only on the days more than one plan holds, and each plan's days count what the
 * others had eaten.
 */
export async function diaryOfPlans(
  db: Db,
  profileId: string,
  plans: readonly { id: string; days: readonly { date: Date }[] }[],
): Promise<Map<string, Map<string, DiaryOnDay>>> {
  const dates = plans.flatMap((plan) => plan.days.map((day) => day.date.getTime()));
  if (dates.length === 0) return new Map();
  const from = new Date(Math.min(...dates));
  const to = new Date(Math.max(...dates));
  const read = await readDiary(db, profileId, from, to, { overlapping: true });
  const eaten = read.eaten ? await eatenMeals(db, profileId, from, to, { overlapping: true }) : [];
  return new Map(
    plans.map((plan) => [
      plan.id,
      besidePlan(
        read.entries,
        eaten.filter((meal) => meal.planId !== plan.id),
      ),
    ]),
  );
}
