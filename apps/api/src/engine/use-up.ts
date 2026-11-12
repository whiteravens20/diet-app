// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Swaps that use up what a plan opens.
 *
 * While a plan is filled the planner leans towards the packs it has opened, a
 * meal at a time and without looking back. This looks at the plan as it
 * stands: for every meal that may be given another recipe, whether one of the
 * recipes that may take its place leaves less of the packs that do not keep.
 * It finds what the fill could not see, and what swaps since have left.
 */
import { fitServings } from './optimizer.js';
import {
  packsLeftBeyondAccepted,
  packUse,
  SPOONFUL,
  type DailyNeeds,
  type Pack,
  type PackUse,
} from './packs.js';

/** A recipe that may take the place of a meal. */
export interface UseUpCandidate {
  recipeId: string;
  caloriesPerServing: number;
  /** What one serving takes of each ingredient, in the ingredient's own unit. */
  amounts: ReadonlyMap<string, number>;
}

/** A meal of a plan that may be given another recipe. */
export interface UseUpMeal {
  id: string;
  recipeId: string;
  /** The day of the plan its ingredients are taken on, by its place among the days: the day the dish is cooked. */
  day: number;
  /** The energy the meal holds now: what a recipe in its place is sized to. */
  held: number;
  /** What the meal takes of each ingredient now. */
  amounts: ReadonlyMap<string, number>;
  candidates: readonly UseUpCandidate[];
}

/** What a menu buys in packs that do not keep, against what it uses, and how many of them it leaves more than a fifth of. */
export interface PackTally {
  bought: number;
  used: number;
  wasted: number;
}

export const tallyOf = (use: PackUse): PackTally => ({
  bought: use.bought,
  used: use.used,
  wasted: use.open.filter((pack) => pack.wasted).length,
});

/** A recipe in the place of a meal, and what that does to the packs. */
export interface UseUpSwap {
  mealId: string;
  recipeId: string;
  servings: number;
  before: PackTally;
  after: PackTally;
  /** Of the packs the menu leaves more than a fifth of: how much more of each the swap takes, and what is then left of the last pack. */
  takes: Map<string, { amount: number; left: number }>;
}

/** What a menu leaves of an ingredient in its packs, all of them together. */
const leftOf = (use: PackUse, ingredientId: string): number =>
  use.open.reduce((sum, pack) => (pack.ingredientId === ingredientId ? sum + pack.left : sum), 0);

/** `needs` with what one meal takes on its day taken away, or another meal's amounts added. */
function changed(
  needs: DailyNeeds,
  day: number,
  amounts: ReadonlyMap<string, number>,
  sign: 1 | -1,
): Map<string, number[]> {
  const out = new Map([...needs].map(([id, row]) => [id, [...row]]));
  for (const [ingredientId, amount] of amounts) {
    const row = out.get(ingredientId);
    if (row) row[day] = Math.max(0, row[day]! + sign * amount);
  }
  return out;
}

/**
 * The swaps after which the menu leaves less of its packs, counted day by day
 * (`packUse`): one for a meal, the one that leaves the least first, `most` at
 * most. A swap counts when it takes at least a spoonful of a pack off what is
 * left beyond the accepted fifth, over all packs together: one that finishes a
 * pack by opening another and leaving as much of that is no gain.
 *
 * `fixed` is what the meals that cannot be changed take on each of the plan's
 * `days` days (eaten, of days that have passed, the user's own, the toppings),
 * `packs` the pack of each ingredient whose opened pack does not keep. A recipe
 * is sized to what the meal holds, as a swap sizes it.
 */
export function useUpSwaps(
  meals: readonly UseUpMeal[],
  fixed: DailyNeeds,
  packs: ReadonlyMap<string, Pack>,
  days: number,
  most = 5,
): UseUpSwap[] {
  const needs = new Map<string, number[]>();
  const add = (ingredientId: string, day: number, amount: number): void => {
    if (!packs.has(ingredientId) || day < 0 || day >= days) return;
    let row = needs.get(ingredientId);
    if (!row) {
      row = Array.from({ length: days }, () => 0);
      needs.set(ingredientId, row);
    }
    row[day]! += amount;
  };
  for (const [ingredientId, row] of fixed)
    row.forEach((amount, day) => add(ingredientId, day, amount));
  // A candidate may take what no meal takes now: its row is there, empty, to be added to.
  for (const meal of meals) {
    for (const [ingredientId, amount] of meal.amounts) add(ingredientId, meal.day, amount);
    for (const candidate of meal.candidates)
      for (const ingredientId of candidate.amounts.keys()) add(ingredientId, meal.day, 0);
  }
  const use = packUse(needs, packs);
  const before = tallyOf(use);
  const beyondBefore = packsLeftBeyondAccepted(use);
  if (beyondBefore <= 0) return [];
  // The packs of which more than a fifth are left now: what a swap is looked at for.
  const leftOpen = new Set(use.open.filter((pack) => pack.wasted).map((pack) => pack.ingredientId));

  const found: (UseUpSwap & { beyond: number })[] = [];
  for (const meal of meals) {
    let best: (UseUpSwap & { beyond: number }) | null = null;
    for (const candidate of meal.candidates) {
      if (candidate.recipeId === meal.recipeId) continue;
      // Only a recipe that takes from a pack that is left open can use one up.
      if (![...candidate.amounts.keys()].some((ingredientId) => leftOpen.has(ingredientId)))
        continue;
      const servings = fitServings(candidate.caloriesPerServing, meal.held);
      const taken = new Map(
        [...candidate.amounts].map(([ingredientId, perServing]) => [
          ingredientId,
          perServing * servings,
        ]),
      );
      const with_ = changed(changed(needs, meal.day, meal.amounts, -1), meal.day, taken, 1);
      const withUse = packUse(with_, packs);
      const beyond = packsLeftBeyondAccepted(withUse);
      if (beyondBefore - beyond < SPOONFUL) continue;
      const after = tallyOf(withUse);
      const better =
        best === null ||
        beyond < best.beyond - 1e-9 ||
        (Math.abs(beyond - best.beyond) <= 1e-9 &&
          (after.bought < best.after.bought ||
            (after.bought === best.after.bought && candidate.recipeId < best.recipeId)));
      if (!better) continue;
      const takes = new Map<string, { amount: number; left: number }>();
      for (const ingredientId of leftOpen) {
        const more = (taken.get(ingredientId) ?? 0) - (meal.amounts.get(ingredientId) ?? 0);
        if (more > 1e-6)
          takes.set(ingredientId, { amount: more, left: leftOf(withUse, ingredientId) });
      }
      best = {
        mealId: meal.id,
        recipeId: candidate.recipeId,
        servings,
        before,
        after,
        takes,
        beyond,
      };
    }
    if (best) found.push(best);
  }
  return found
    .sort(
      (a, b) =>
        a.beyond - b.beyond || a.after.bought - b.after.bought || (a.mealId < b.mealId ? -1 : 1),
    )
    .slice(0, most)
    .map(({ beyond: _beyond, ...swap }) => swap);
}
