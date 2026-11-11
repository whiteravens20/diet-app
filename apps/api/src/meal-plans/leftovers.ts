// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';
import type { PlannedMeal } from '@diet-app/shared';
import { isoDate, isSkipped, MADE_LAST } from './plan-days.js';

/**
 * What the day after a meal's is for a leftover of it, in the plan of the
 * person made last that holds it: it takes one (`ok`), it is skipped, or each
 * of its meals is eaten or a leftover itself (`no_meal`).
 */
export type NextDay = 'ok' | 'skipped' | 'no_meal';

/** The date `days` after `date`, both as the API writes dates. */
export function dateAfter(date: string, days = 1): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return isoDate(at);
}

/**
 * The days whose meals may give a leftover, yesterday and today, so that it
 * always goes to a day that is not over, and the days those go to.
 */
export function leftoverDays(today: string): { from: string[]; to: string[] } {
  return { from: [dateAfter(today, -1), today], to: [today, dateAfter(today)] };
}

/**
 * A meal a leftover may take the place of: one not eaten that is no leftover
 * itself, nor a meal whose rest is a leftover.
 */
export const takesALeftover = (meal: {
  eatenAt: Date | null;
  leftoverFromDate: Date | null;
  givenLeftoverId: string | null;
}): boolean =>
  meal.eatenAt === null && meal.leftoverFromDate === null && meal.givenLeftoverId === null;

/** What a day of a plan is for a leftover. */
export const nextDayOf = (day: {
  overrides: unknown;
  meals: readonly Parameters<typeof takesALeftover>[0][];
}): NextDay => (isSkipped(day) ? 'skipped' : day.meals.some(takesALeftover) ? 'ok' : 'no_meal');

/** For each of `dates`, what the day is for a leftover in the plan of the profile made last that holds it; none where no plan does. */
export async function nextDaysOf(
  db: Pick<Prisma.TransactionClient, 'mealPlanDay'>,
  profileId: string,
  dates: readonly string[],
): Promise<Map<string, NextDay>> {
  const days = await db.mealPlanDay.findMany({
    where: { date: { in: dates.map((date) => new Date(date)) }, plan: { profileId } },
    orderBy: [{ date: 'asc' }, ...MADE_LAST],
    select: {
      date: true,
      overrides: true,
      meals: { select: { eatenAt: true, leftoverFromDate: true, givenLeftoverId: true } },
    },
  });
  const found = new Map<string, NextDay>();
  for (const day of days) {
    const date = isoDate(day.date);
    // The plan made last comes first.
    if (!found.has(date)) found.set(date, nextDayOf(day));
  }
  return found;
}

/** A meal as far as whether it may give a leftover goes. */
export interface LeftoverGiver {
  source: string;
  recipeId: string | null;
  leftoverFromDate: Date | null;
  givenLeftoverId: string | null;
}

/**
 * Whether a meal may give a leftover at all: one with a recipe that is not a
 * leftover itself, whose rest was not carried yet, of yesterday or today.
 */
export function givesALeftover(meal: LeftoverGiver, date: string, today: string): boolean {
  return (
    meal.source !== 'USER_CUSTOM' &&
    meal.recipeId !== null &&
    meal.leftoverFromDate === null &&
    meal.givenLeftoverId === null &&
    leftoverDays(today).from.includes(date)
  );
}

/** What `PlannedMeal.leftoverOffer` says of a meal of `date`, with what the days after yesterday's and today's are. */
export function leftoverOfferOf(
  meal: LeftoverGiver,
  date: string,
  today: string,
  nextDays: ReadonlyMap<string, NextDay>,
): PlannedMeal['leftoverOffer'] {
  if (!givesALeftover(meal, date, today)) return null;
  return nextDays.get(dateAfter(date)) ?? 'no_day';
}
