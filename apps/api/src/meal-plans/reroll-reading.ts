// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { MEAL_SLOTS_BY_COUNT, type MealType, type RerollPreview } from '@diet-app/shared';
import { dayMealCount, parseDayOverrides } from './plan-days.js';

/** A meal of a day, as a re-roll reads it. */
export interface RerollMeal {
  mealType: string;
  recipeId: string | null;
  source: string;
  eatenAt: Date | null;
  /** Set on a leftover: food there is already, which a re-roll keeps while it is not eaten. */
  leftoverFromDate: Date | null;
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
  /**
   * Every dish of the catalogue at a time of day the day keeps stays as well ("Uzupełnij lub odejmij"): only the times
   * a new number of meals adds are filled, and the dishes of those it drops go.
   */
  keepDishes?: boolean;
}

/**
 * The times of day a day keeps for the meals of it that stay (`staying`, of `meals`): the time of a meal of the
 * catalogue that stays, and the time of a meal of the user's own where no meal of the catalogue is at it, a time they
 * gave to their own. Where one of the catalogue stands beside one of their own, the time is the plan's, filled again
 * when that meal gives place.
 */
export function heldTimes(
  meals: readonly { mealType: string; source: string }[],
  staying: readonly { mealType: string; source: string }[],
): Set<string> {
  const ofCatalogue = new Set(
    meals.filter((meal) => meal.source === 'CATALOGUE').map((meal) => meal.mealType),
  );
  return new Set(
    staying
      .filter((meal) => meal.source === 'CATALOGUE' || !ofCatalogue.has(meal.mealType))
      .map((meal) => meal.mealType),
  );
}

/**
 * What a re-roll does with a day. A day that was not asked for, and one before
 * today unless the request takes those, stay as they are. A day that is filled
 * again keeps the meals marked as eaten and the user's own unless the request
 * lets them go, and a leftover not eaten always; a day the user skips keeps
 * them whatever it says, and gets nothing. The meals that stay hold their times of day (`heldTimes`): those of the
 * catalogue always, the user's own where no meal of the catalogue is at their time, and beside it otherwise; the
 * other places of the day's meals (`slots`) are filled, a place locked to a recipe with that recipe.
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

/**
 * Why a meal stays on a day that is filled again: it is the user's own, a
 * leftover not eaten, which always stays, or it was eaten; null where it gives
 * place.
 */
function stayingFor(meal: RerollMeal, asked: RerollAsked): 'custom' | 'leftover' | 'eaten' | null {
  if (meal.source === 'USER_CUSTOM' && !asked.replaceCustom) return 'custom';
  if (meal.leftoverFromDate !== null && meal.eatenAt === null) return 'leftover';
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
  const times: readonly MealType[] = MEAL_SLOTS_BY_COUNT[day.mealCount] ?? MEAL_SLOTS_BY_COUNT[3]!;
  const staying = day.meals.filter(
    (meal) =>
      stayingFor(meal, keeps) !== null ||
      (asked.keepDishes === true &&
        meal.source === 'CATALOGUE' &&
        times.includes(meal.mealType as MealType)),
  );
  const held = heldTimes(day.meals, staying);
  return {
    fate: day.skipped ? 'skipped' : 'again',
    staying,
    slots: times.filter((slot) => !held.has(slot)),
    locks: day.locks.filter((lock) => !held.has(lock.mealType)),
  };
}

/**
 * What a re-roll asked for with `asked` would do to the days of a plan, read
 * day by day as the re-roll reads them (`readReroll`). On a day that is filled
 * again, a meal that gives place in a place locked to its own recipe gets the
 * recipe back, and is counted as kept. The day changes where another meal gives
 * place, or a place of it is filled that no such meal holds: a day whose meals
 * all stay is filled where they leave a place free, where a meal was taken off
 * it and none of the user's own took its time.
 */
export function rerollOutcome(
  days: readonly RerollDay[],
  asked: RerollAsked,
  today: string,
): Omit<RerollPreview, 'fromToday' | 'cooking'> {
  const kept = { outside: 0, past: 0, skipped: 0, eaten: 0, custom: 0, leftover: 0, locked: 0 };
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
