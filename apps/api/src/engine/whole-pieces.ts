// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Eggs and tortillas in whole pieces.
 *
 * Nobody cooks half an egg or warms half a tortilla. What one cooking takes of
 * such an ingredient (a pot) is rounded to the nearest whole piece, and to one
 * where it takes any at all; each meal the pot feeds takes its share of that, in
 * the proportion of what it takes exactly. A pot is a meal cooked on its own, a
 * dish two people eat from one pot, or a dish cooked once for more meals: a
 * share of one of those may be half an egg, the pot never is.
 *
 * The factor of a meal's exact amount this gives (the pot's whole pieces over
 * its exact ones) is what every reader of what a meal holds and uses takes: its
 * figures, its lines, the shopping list. The servings and the factor a
 * rebalance leaves on a meal stay as they are: the planner fits a day on what a
 * serving holds, and the pieces are rounded after it.
 */

/** The ingredients a planned meal uses whole, by slug. */
export const WHOLE_PIECE_SLUGS: readonly string[] = ['large-egg', 'tortilla-wrap'];

/**
 * What a planned meal takes of an ingredient it uses whole (`engine/whole-pieces.ts`): how much
 * exactly, the factor its pot puts on that, and what 100 canonical units of it hold. A reader adds
 * `(factor - 1) * exact` of it to the meal's figures and multiplies its lines and its shopping by
 * `factor`.
 */
export interface PieceUse {
  ingredientId: string;
  /** What the meal takes exactly, in the ingredient's canonical unit. */
  exact: number;
  /** The pot's whole pieces over its exact ones: 1 where the pot keeps what it was planned with. */
  factor: number;
  per100: { calories: number; protein: number; fat: number; carbs: number };
  label: {
    fiber: number | null;
    sugars: number | null;
    salt: number | null;
    saturatedFat: number | null;
  };
}

/** What one meal of a pot takes exactly of an ingredient used whole, in pieces. */
export interface PotTake {
  meal: string;
  ingredient: string;
  pieces: number;
}

/** The noise of converting units: 1.4999999997 pieces are a half and a whole one. */
const EPSILON = 1e-6;

/** The whole pieces a pot takes of what it takes `exact` pieces of: the nearest number, a half up, and at least one. */
export function wholePieces(exact: number): number {
  if (exact <= EPSILON) return 0;
  return Math.max(1, Math.round(exact + EPSILON));
}

/**
 * For each pot, each meal's factor of its exact amount of each ingredient used
 * whole: the pot's whole pieces over its exact ones, the same for every meal of
 * the pot. A meal and an ingredient not named stay as they are (a factor of 1).
 */
export function wholePieceFactors(
  pots: readonly (readonly PotTake[])[],
): Map<string, Map<string, number>> {
  const factors = new Map<string, Map<string, number>>();
  for (const pot of pots) {
    const exact = new Map<string, number>();
    for (const take of pot)
      exact.set(take.ingredient, (exact.get(take.ingredient) ?? 0) + take.pieces);
    for (const take of pot) {
      const total = exact.get(take.ingredient)!;
      if (total <= EPSILON) continue;
      const ofMeal = factors.get(take.meal) ?? new Map<string, number>();
      ofMeal.set(take.ingredient, wholePieces(total) / total);
      factors.set(take.meal, ofMeal);
    }
  }
  return factors;
}

/**
 * The pots of a set of meals: groups of meals cooked together, joined by the
 * links given (a dish both people eat, a leftover and the meal it was left of,
 * a dish cooked once for more meals). A meal no link names is a pot of its own.
 */
export function linkedPots(
  meals: readonly string[],
  links: readonly (readonly string[])[],
): string[][] {
  const parent = new Map(meals.map((meal) => [meal, meal]));
  const root = (meal: string): string => {
    let at = meal;
    while (parent.get(at) !== at) at = parent.get(at)!;
    // Shorten the path walked, so that the next walk is one step.
    let step = meal;
    while (parent.get(step) !== at) {
      const next = parent.get(step)!;
      parent.set(step, at);
      step = next;
    }
    return at;
  };
  for (const link of links) {
    const known = link.filter((meal) => parent.has(meal));
    for (const meal of known.slice(1)) parent.set(root(meal), root(known[0]!));
  }
  const pots = new Map<string, string[]>();
  for (const meal of meals) {
    const at = root(meal);
    pots.set(at, [...(pots.get(at) ?? []), meal]);
  }
  return [...pots.values()];
}
