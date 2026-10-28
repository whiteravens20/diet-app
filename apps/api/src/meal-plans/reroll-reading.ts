// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { MEAL_SLOTS_BY_COUNT, type MealType, type RerollPreview } from '@diet-app/shared';
import { dayMealCount, parseDayOverrides } from './plan-days.js';

/** A meal of a day, as a re-roll reads it. */
export interface RerollMeal {
  mealType: string;
  recipeId: string | null;
  source: string;
  eatenAt: Date | null;
}

/** A day of a plan, as a re-roll reads it. */
export interface RerollDay<M extends RerollMeal = RerollMeal> {
  /** `2026-03-01`. */
  date: string;
  /** The user skips it. */
  skipped: boolean;
  /** How many meals it is set for (`dayMealCount`). */
  mealCount: number;
  /** The recipes the user locked to its meals. */
  locks: readonly { mealType: MealType; recipeId: string }[];
  meals: readonly M[];
}

/**
 * A day of a plan as a re-roll reads it, from its row: `date` as `2026-03-01`,
 * and the numbers of meals a day the plan and the profile are set for, which
 * say the day's own where it has none (`dayMealCount`).
 */
export function rerollDayOf<M extends RerollMeal>(
  day: { overrides: unknown; meals: M[] },
  date: string,
  planCount: number | null,
  profileCount: number,
): RerollDay<M> {
  const overrides = parseDayOverrides(day.overrides);
  return {
    date,
    skipped: overrides?.skip === true,
    mealCount: dayMealCount(day, planCount, profileCount),
    locks: overrides?.lockedSlots ?? [],
    meals: day.meals,
  };
}

/** What a re-roll is asked for: its days, the first and the last of them, and what it may let go that it otherwise keeps. */
export interface RerollAsked {
  first: string;
  last: string;
  includePast: boolean;
  replaceEaten: boolean;
  replaceCustom: boolean;
}

/**
 * What a re-roll does with a day. A day that was not asked for, and one before
 * today unless the request takes those, stay as they are. A day that is filled
 * again keeps the meals marked as eaten and the user's own unless the request
 * lets them go; a day the user skips keeps them whatever it says, and gets
 * nothing. Of the meals that stay, those of the catalogue hold their places and
 * the user's own stand beside them; the other places of the day's meals
 * (`slots`) are filled, a place locked to a recipe with that recipe.
 */
export type RerollReading<M extends RerollMeal> =
  | { fate: 'outside' }
  | { fate: 'past' }
  | {
      fate: 'skipped' | 'again';
      staying: M[];
      slots: MealType[];
      locks: { mealType: MealType; recipeId: string }[];
    };

/** Why a meal stays on a day that is filled again: it is the user's own, or it was eaten; null where it gives place. */
function stayingFor(meal: RerollMeal, asked: RerollAsked): 'custom' | 'eaten' | null {
  if (meal.source === 'USER_CUSTOM' && !asked.replaceCustom) return 'custom';
  if (meal.eatenAt !== null && !asked.replaceEaten) return 'eaten';
  return null;
}

/** What a re-roll asked for with `asked` does with `day`, `today` being the day it is for whoever asks. */
export function readReroll<M extends RerollMeal>(
  day: RerollDay<M>,
  asked: RerollAsked,
  today: string,
): RerollReading<M> {
  // Dates in this form sort as text.
  if (day.date < asked.first || day.date > asked.last) return { fate: 'outside' };
  if (day.date < today && !asked.includePast) return { fate: 'past' };
  const keeps = day.skipped ? { ...asked, replaceEaten: false, replaceCustom: false } : asked;
  const staying = day.meals.filter((meal) => stayingFor(meal, keeps) !== null);
  const held = new Set(
    staying.filter((meal) => meal.source === 'CATALOGUE').map((meal) => meal.mealType),
  );
  return {
    fate: day.skipped ? 'skipped' : 'again',
    staying,
    slots: (MEAL_SLOTS_BY_COUNT[day.mealCount] ?? MEAL_SLOTS_BY_COUNT[3]!).filter(
      (slot) => !held.has(slot),
    ),
    locks: day.locks.filter((lock) => !held.has(lock.mealType)),
  };
}

/**
 * What a re-roll asked for with `asked` would do to the days of a plan, read
 * day by day as the re-roll reads them (`readReroll`). On a day that is filled
 * again, a meal that gives place in a place locked to its own recipe gets the
 * recipe back, and is counted as kept. The day changes where another meal gives
 * place, or a place of it is filled that no such meal holds: a day whose meals
 * all stay is filled where they leave a place free, beside a meal of the user's
 * own, or where a meal was taken off it.
 */
export function rerollOutcome(
  days: readonly RerollDay[],
  asked: RerollAsked,
  today: string,
): Omit<RerollPreview, 'fromToday'> {
  const kept = { outside: 0, past: 0, skipped: 0, eaten: 0, custom: 0, locked: 0 };
  const couldGo = { past: false, eaten: false, custom: false };
  let changed = 0;
  let replaced = 0;
  for (const day of days) {
    const reading = readReroll(day, asked, today);
    if (reading.fate !== 'outside' && day.date < today) couldGo.past = true;
    if (reading.fate !== 'again') {
      kept[reading.fate] += 1;
      continue;
    }
    if (day.meals.some((meal) => meal.eatenAt !== null)) couldGo.eaten = true;
    if (day.meals.some((meal) => meal.source === 'USER_CUSTOM')) couldGo.custom = true;
    let gone = 0;
    let locked = 0;
    for (const meal of day.meals) {
      const why = stayingFor(meal, asked);
      if (why !== null) kept[why] += 1;
      else if (
        meal.source === 'CATALOGUE' &&
        reading.slots.some((slot) => slot === meal.mealType) &&
        reading.locks.some(
          (lock) => lock.mealType === meal.mealType && lock.recipeId === meal.recipeId,
        )
      )
        locked += 1;
      else gone += 1;
    }
    kept.locked += locked;
    replaced += gone;
    if (gone > 0 || reading.slots.length > locked) changed += 1;
  }
  return { days: changed, replaced, kept, couldGo };
}
