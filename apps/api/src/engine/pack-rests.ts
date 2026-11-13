// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The rest of a pack into the meal that finishes it: a step after the packs of
 * a plan that wastes less are closed (`closePacks`) and its toppings given.
 *
 * What the kitchen leaves in a pack that does not keep, the last meal that
 * takes from the pack while it keeps takes as well, where that is a little:
 * the rest is at most a share of what the meal takes of the ingredient itself,
 * it adds at most a share to the meal's energy, all the rests of a day add at
 * most a share of the day's target, and the day stays inside its window. The
 * other meals of the day do not change. A dish cooked ahead and a meal both
 * people of a joint plan eat take the rest into the pot, each portion its
 * share by its size. A rest is taken whole or not at all, and one smaller
 * than a spoonful of its pack (`SPOONFUL`) stays in the pack.
 */
import type { MealType } from '@diet-app/shared';
import { kitchenNeeds, potsOf, type ClosingPlan, type Pot } from './close-packs.js';
import { packUse, SPOONFUL, type DailyNeeds, type Pack } from './packs.js';
import { REBALANCE_TOLERANCE } from './rebalance.js';

/** How much a rest may be. */
export interface RestCaps {
  /** At most this share of what the meal, or the pot, takes of the ingredient itself. */
  ofOwn: number;
  /** All the rests of a meal, or a pot, add at most this share to its energy. */
  ofMeal: number;
  /** All the rests of a day add at most this share of its calorie target. */
  ofDay: number;
}

/** The rests of a plan that wastes less: half the meal's own amount, a tenth of its energy, 3 % of the day. */
export const LESS_WASTE_RESTS: RestCaps = { ofOwn: 0.5, ofMeal: 0.1, ofDay: 0.03 };

/** The rests of a plan that wastes nothing: as much again as the meal takes, 15 % more of its energy, 5 % of the day. */
export const NO_WASTE_RESTS: RestCaps = { ofOwn: 1, ofMeal: 0.15, ofDay: 0.05 };

/** A plan of the kitchen as it was finished, with what the toppings of its meals take and hold. */
export interface RestPlan extends Pick<
  ClosingPlan,
  'recipes' | 'days' | 'assignments' | 'mealPrepFriendly'
> {
  /** The topping of a meal, by the meal's place among the assignments: what it takes of a pack, and its energy. */
  toppings?: ReadonlyMap<number, { ingredientId: string; amount: number; calories: number }>;
}

export interface RestInput {
  /** The plans of one kitchen, on the same days: one, or the two of a joint plan. */
  plans: readonly RestPlan[];
  /** Of the two plans of a joint plan, the meals both eat (`ClosingInput.shared`). */
  shared?: readonly { dayIndex: number; slot: MealType }[];
  /** What stays in the plans takes of the packs on each day, beside the meals placed and their toppings. */
  fixed?: DailyNeeds;
  /** The pack of each ingredient whose opened pack does not keep, those of the toppings among them. */
  packs: ReadonlyMap<string, Pack>;
  /** The energy of 100 of each ingredient's own unit. */
  energyPer100: ReadonlyMap<string, number>;
  caps: RestCaps;
}

/** A rest a meal takes: of which ingredient, and how much, in the ingredient's own unit. */
export interface MealRest {
  ingredientId: string;
  amount: number;
}

/** Less than this of an ingredient's own unit left in a pack, or less than a spoonful of the pack, is no rest to speak of. */
const LEAST_REST = 1;

/** The rests each meal of each plan takes, by the meal's place among its plan's assignments. */
export function packRests(input: RestInput): Map<number, MealRest[]>[] {
  const { plans, packs, caps } = input;
  const rests = plans.map(() => new Map<number, MealRest[]>());
  const length = Math.max(0, ...plans.map((plan) => plan.days.length));
  const recipeOf = plans.map((plan) => new Map(plan.recipes.map((recipe) => [recipe.id, recipe])));

  // The kitchen, the toppings of its meals with what stays in it.
  const fixed = new Map<string, number[]>();
  const take = (ingredientId: string, day: number, amount: number): void => {
    if (day < 0 || day >= length) return;
    let row = fixed.get(ingredientId);
    if (!row) {
      row = Array.from({ length }, () => 0);
      fixed.set(ingredientId, row);
    }
    row[day]! += amount;
  };
  for (const [ingredientId, row] of input.fixed ?? [])
    row.forEach((amount, day) => take(ingredientId, day, amount));
  for (const plan of plans)
    for (const [index, topping] of plan.toppings ?? [])
      take(topping.ingredientId, plan.assignments[index]!.dayIndex, topping.amount);
  const left = packUse(kitchenNeeds(plans, fixed, packs), packs).open;
  if (left.length === 0) return rests;

  /** What a meal takes of an ingredient, at its servings and portion. */
  const amountOf = (plan: number, index: number, ingredientId: string): number => {
    const meal = plans[plan]!.assignments[index]!;
    const perServing = recipeOf[plan]!.get(meal.recipeId)?.amounts?.get(ingredientId) ?? 0;
    return perServing * meal.servings * meal.quantityScale;
  };
  /** The energy of a meal's dish. */
  const energyOf = (plan: number, index: number): number => {
    const meal = plans[plan]!.assignments[index]!;
    return (
      (recipeOf[plan]!.get(meal.recipeId)?.caloriesPerServing ?? 0) *
      meal.servings *
      meal.quantityScale
    );
  };
  // The energy of each day of each plan: what stays on it, its meals and their toppings.
  const dayEnergy = plans.map((plan) =>
    plan.days.map((day) => (day.kept ?? []).reduce((sum, meal) => sum + meal.calories, 0)),
  );
  plans.forEach((plan, p) =>
    plan.assignments.forEach((meal, index) => {
      dayEnergy[p]![meal.dayIndex]! +=
        energyOf(p, index) + (plan.toppings?.get(index)?.calories ?? 0);
    }),
  );
  // What the rests add to each day of each plan, and to each pot, as they are given.
  const toDays = plans.map((plan) => plan.days.map(() => 0));
  const toPots = new Map<Pot, number>();

  const { pots } = potsOf(plans, input.shared);
  for (const pack of left) {
    const per100 = input.energyPer100.get(pack.ingredientId);
    const sold = packs.get(pack.ingredientId);
    const keep = sold?.keepDays;
    const least = Math.max(LEAST_REST, SPOONFUL * (sold?.size ?? 0));
    if (pack.left < least || per100 === undefined || keep === undefined) continue;
    // The pot that takes from the pack last while it keeps: the pots come in the order they are cooked.
    const opened = pack.until - keep + 1;
    let last: Pot | undefined;
    for (const pot of pots) {
      const day = pot.takenOn[0]!;
      if (day < opened || day > pack.until) continue;
      if (pot.places.some((place) => amountOf(place.plan, place.index, pack.ingredientId) > 0))
        last = pot;
    }
    if (last === undefined) continue;
    const own = last.places.map((place) => amountOf(place.plan, place.index, pack.ingredientId));
    const ownAll = own.reduce((sum, amount) => sum + amount, 0);
    if (pack.left > caps.ofOwn * ownAll + 1e-9) continue;
    const energy = (pack.left * per100) / 100;
    const potEnergy = last.places.reduce(
      (sum, place) => sum + energyOf(place.plan, place.index),
      0,
    );
    if ((toPots.get(last) ?? 0) + energy > caps.ofMeal * potEnergy + 1e-9) continue;
    // Each portion its share, by its size; each of their days within its caps.
    const shares = own.map((amount) => amount / ownAll);
    const fits = last.places.every((place, i) => {
      const day = plans[place.plan]!.assignments[place.index]!.dayIndex;
      const target = plans[place.plan]!.days[day]!.dailyCalorieTarget;
      const more = toDays[place.plan]![day]! + energy * shares[i]!;
      return (
        more <= caps.ofDay * target + 1e-9 &&
        dayEnergy[place.plan]![day]! + more <= (1 + REBALANCE_TOLERANCE) * target + 1e-9
      );
    });
    if (!fits) continue;
    last.places.forEach((place, i) => {
      if (shares[i]! <= 0) return;
      const day = plans[place.plan]!.assignments[place.index]!.dayIndex;
      toDays[place.plan]![day]! += energy * shares[i]!;
      const given = rests[place.plan]!.get(place.index) ?? [];
      given.push({ ingredientId: pack.ingredientId, amount: pack.left * shares[i]! });
      rests[place.plan]!.set(place.index, given);
    });
    toPots.set(last, (toPots.get(last) ?? 0) + energy);
  }
  return rests;
}
