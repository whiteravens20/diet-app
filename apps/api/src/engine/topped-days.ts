// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A day of one person of a joint plan sized with the toppings its shared meals
 * are given: where the day, sized as far as its portions go, stays off its
 * split or its calorie target, a topping is put on one of its shared meals
 * (`bestTopping`) and the day is sized again around it, the topping counted
 * and never moved; then the next, at most one a meal, as long as one brings
 * the day nearer. Of the toppings that bring the day back, the one the person
 * had least in the days around it comes first, so that the same one is not
 * put on day after day. A day that nothing brings nearer keeps what the rest
 * of it makes up, and says so as any day off its target does.
 *
 * Pure: the same day gives the same toppings and portions.
 */
import type { Macros } from '@diet-app/shared';
import type { PackKitchen } from './close-packs.js';
import type { OptimizerDay, OptimizerRecipe } from './optimizer.js';
import {
  aimOfPlanned,
  assignedDayMeals,
  sizeDay,
  type RebalanceMeal,
  type SizedAssignment,
} from './rebalance.js';
import {
  bestTopping,
  type Figures,
  type ToppingChoice,
  type ToppingDish,
  type ToppingEater,
  type ToppingOption,
  type ToppingPlace,
} from './toppings.js';

/** The id a topping counts under when its meal's day is sized. */
const toppingId = (mealId: string): string => `topping:${mealId}`;

/** A meal's topping as a row the sizing of its day counts and never moves. */
function toppingRow(mealId: string, per100: Figures, amount: number): RebalanceMeal {
  const part = amount / 100;
  return {
    id: toppingId(mealId),
    calories: per100.calories * part,
    servings: 1,
    quantityScale: 1,
    locked: true,
    macros: { protein: per100.protein * part, fat: per100.fat * part, carbs: per100.carbs * part },
  };
}

/** What a day's meals hold at the given portions. */
function figuresOf(meals: readonly RebalanceMeal[], scales: ReadonlyMap<string, number>): Figures {
  const held = { calories: 0, protein: 0, fat: 0, carbs: 0 };
  for (const meal of meals) {
    const amount = meal.servings * (scales.get(meal.id) ?? meal.quantityScale);
    held.calories += meal.calories * amount;
    held.protein += (meal.macros?.protein ?? 0) * amount;
    held.fat += (meal.macros?.fat ?? 0) * amount;
    held.carbs += (meal.macros?.carbs ?? 0) * amount;
  }
  return held;
}

/**
 * The day's meals sized, with the toppings put on its `places`: the portions
 * of its meals by id, toppings left out, and the toppings in the order given.
 */
export function topAndSizeDay(
  meals: readonly RebalanceMeal[],
  target: number,
  aim: Macros,
  places: readonly ToppingPlace[],
  options: readonly ToppingOption[],
  eater: ToppingEater,
  used: ReadonlyMap<string, number> = new Map(),
  leavesMore?: (option: ToppingOption, amount: number) => number,
): { scales: Map<string, number>; toppings: ToppingChoice[] } {
  const per100Of = new Map(options.map((option) => [option.topping.key, option.per100]));
  const rows = [...meals];
  let { scales } = sizeDay(rows, target, aim);
  const toppings: ToppingChoice[] = [];
  // What the person had in the days around it, and what this day is given as it goes.
  const had = new Map(used);
  let open = [...places];
  while (open.length > 0) {
    const choice = bestTopping(
      figuresOf(rows, scales),
      target,
      aim,
      open,
      options,
      eater,
      had,
      leavesMore,
    );
    if (choice === null) break;
    rows.push(toppingRow(choice.mealId, per100Of.get(choice.key)!, choice.amount));
    toppings.push(choice);
    had.set(choice.key, (had.get(choice.key) ?? 0) + 1);
    open = open.filter((place) => place.mealId !== choice.mealId);
    ({ scales } = sizeDay(rows, target, aim));
  }
  for (const choice of toppings) scales.delete(toppingId(choice.mealId));
  return { scales, toppings };
}

/** A meal a run of the planner placed and sized, with the topping its plate is given, if any. */
export type ToppedAssignment = SizedAssignment & {
  topping: { key: string; amount: number } | null;
};

/**
 * The meals a run of the planner placed and sized (`sizeAssignments`), each
 * day of them topped and sized again (`topAndSizeDay`): `dishOf` names the
 * traits of a meal that is a place for a topping, null for one that is not;
 * `eaterOn` is the person as the check reads them on that day. The toppings
 * of the six days before a day count as what the person had of late. In a plan
 * that wastes less, `kitchen` holds the packs of the plans cooked together,
 * which the toppings are chosen by (`bestTopping`) and taken from, day by day.
 */
export function topAssignments(
  days: readonly OptimizerDay[],
  recipes: readonly OptimizerRecipe[],
  sized: readonly SizedAssignment[],
  split: Macros,
  dishOf: (meal: SizedAssignment) => ToppingDish | null,
  options: readonly ToppingOption[],
  eaterOn: (dayIndex: number) => ToppingEater,
  kitchen?: PackKitchen,
): ToppedAssignment[] {
  const optionOf = new Map(options.map((option) => [option.topping.key, option]));
  const recipeOf = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const topped = new Map<
    SizedAssignment,
    { quantityScale: number; topping: ToppedAssignment['topping'] }
  >();
  const given: { dayIndex: number; key: string }[] = [];
  days.forEach((day, dayIndex) => {
    const placed = sized.filter((meal) => meal.dayIndex === dayIndex);
    const places = placed.flatMap((meal) => {
      const dish = dishOf(meal);
      return dish ? [{ mealId: meal.slot, meal: meal.slot, dish }] : [];
    });
    if (places.length === 0 || options.length === 0) return;
    const { scales, toppings } = topAndSizeDay(
      assignedDayMeals(day, placed, recipeOf),
      day.dailyCalorieTarget,
      aimOfPlanned(day, split),
      places,
      options,
      eaterOn(dayIndex),
      given
        .filter((one) => one.dayIndex >= dayIndex - 6)
        .reduce(
          (had, one) => had.set(one.key, (had.get(one.key) ?? 0) + 1),
          new Map<string, number>(),
        ),
      kitchen
        ? (option, amount) =>
            option.pack ? kitchen.leavesMore(option.food.id, option.pack, dayIndex, amount) : 0
        : undefined,
    );
    if (toppings.length === 0) return;
    for (const choice of toppings) {
      given.push({ dayIndex, key: choice.key });
      const option = optionOf.get(choice.key);
      if (kitchen && option?.pack) kitchen.take(option.food.id, dayIndex, choice.amount);
    }
    for (const meal of placed) {
      const choice = toppings.find((one) => one.mealId === meal.slot);
      topped.set(meal, {
        quantityScale: Math.round((scales.get(meal.slot) ?? meal.quantityScale) * 100) / 100,
        topping: choice ? { key: choice.key, amount: choice.amount } : null,
      });
    }
  });
  return sized.map((meal) => {
    const change = topped.get(meal);
    return change ? { ...meal, ...change } : { ...meal, topping: null };
  });
}

/**
 * The kinds of protein a day of a plan has no more meals of: as many of the
 * day's meals hold the kind as its limit for a day allows, or as many of some
 * seven days the day is one of as its limit for seven days allows.
 */
export function fullKindsOn(
  dayIndex: number,
  meals: readonly { dayIndex: number; recipeId: string }[],
  kindsOf: (recipeId: string) => readonly string[],
  limits: ReadonlyMap<string, { perDay?: number; perWeek?: number }>,
): Set<string> {
  const held = (kind: string, from: number, to: number): number =>
    meals.filter(
      (meal) =>
        meal.dayIndex >= from && meal.dayIndex <= to && kindsOf(meal.recipeId).includes(kind),
    ).length;
  const full = new Set<string>();
  for (const [kind, limit] of limits) {
    if (limit.perDay !== undefined && held(kind, dayIndex, dayIndex) >= limit.perDay)
      full.add(kind);
    else if (limit.perWeek !== undefined) {
      for (let start = Math.max(0, dayIndex - 6); start <= dayIndex; start += 1) {
        if (held(kind, start, start + 6) >= limit.perWeek) {
          full.add(kind);
          break;
        }
      }
    }
  }
  return full;
}
