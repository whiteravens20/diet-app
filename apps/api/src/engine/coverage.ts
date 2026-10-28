// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What a catalogue can serve: for every diet and every meal, how many recipes
 * a plan has to choose from. A cell at zero means no plan can be made for
 * that diet with that meal; a cell below the variety a week asks for means
 * the same dish day after day.
 *
 * Pure, and the same rule (`fitsDiet`) as the planner's own pool.
 */
import {
  DietType,
  MEAL_SLOTS_BY_COUNT,
  MealCountKey,
  MealType,
  VARIETY_DEPTH,
  fitsDiet,
  type CatalogueSupply,
  type Macros,
  type Supply,
} from '@diet-app/shared';
import { energyShares, macroSplitOf, splitDistance } from './nutrition.js';
import { OptimizerError, optimisePlan, uniformDays, type OptimizerRecipe } from './optimizer.js';
import { packUse } from './packs.js';

/**
 * The fewest recipes a catalogue needs for any diet and meal: a week without
 * the same dish twice, and room to swap. The data lint fails below it.
 */
export const COVERAGE_FLOOR = 6;

/**
 * The recipes the panel aims at for any diet and meal: in a plan of four
 * weeks a dish comes back about one time and a half. A run that fills what
 * the catalogue lacks writes until every pair has as many.
 */
export const COVERAGE_TARGET = 20;

export type CoverageMatrix = Record<DietType, Record<MealType, number>>;

export function recipesPerDietAndMeal(
  recipes: readonly { dietTags: readonly string[]; mealTypes: readonly string[] }[],
): CoverageMatrix {
  const matrix = {} as CoverageMatrix;
  for (const diet of DietType.options) {
    const row = {} as Record<MealType, number>;
    for (const meal of MealType.options) {
      row[meal] = recipes.filter(
        (recipe) => recipe.mealTypes.includes(meal) && fitsDiet(recipe.dietTags, diet),
      ).length;
    }
    matrix[diet] = row;
  }
  return matrix;
}

/**
 * For each diet and number of meals a day, how well the catalogue serves it:
 * by the recipes the thinnest of the day's meals can choose from, and the
 * largest smaller number of meals a day that can be planned at all.
 */
export function supplyByMealCount(matrix: CoverageMatrix): CatalogueSupply {
  const supply = {} as CatalogueSupply;
  for (const diet of DietType.options) {
    const thinnest = (count: number): number =>
      Math.min(...MEAL_SLOTS_BY_COUNT[count]!.map((meal) => matrix[diet][meal]));
    supply[diet] = Object.fromEntries(
      MealCountKey.options.map((key): [MealCountKey, Supply] => {
        const count = Number(key);
        const recipes = thinnest(count);
        return [
          key,
          {
            level: recipes === 0 ? 'none' : recipes < VARIETY_DEPTH ? 'thin' : 'enough',
            recipes,
            fewerMeals: [4, 3, 2].find((fewer) => fewer < count && thinnest(fewer) > 0) ?? null,
          },
        ];
      }),
    ) as Record<MealCountKey, Supply>;
  }
  return supply;
}

/** The emptiest cell among the diets that need recipes of their own; the first in a fixed order when several are as empty. */
export function thinnestCell(matrix: CoverageMatrix): {
  diet: DietType;
  meal: MealType;
  recipes: number;
} {
  let thinnest: { diet: DietType; meal: MealType; recipes: number } | null = null;
  for (const diet of DietType.options) {
    if (diet === 'custom') continue;
    for (const meal of MealType.options) {
      if (!thinnest || matrix[diet][meal] < thinnest.recipes)
        thinnest = { diet, meal, recipes: matrix[diet][meal] };
    }
  }
  return thinnest!;
}

/**
 * The average day of a diet's plans is this far from the diet's split, or
 * further: the catalogue does not let a plan be what the diet promises.
 */
export const MACRO_OUT_OF_REACH = 0.1;

/** What the plans of a diet reach: the shares of the average day's energy, and how far that is from the diet's split. */
export interface MacroReach extends Macros {
  distance: number;
  /**
   * Of what the weeks buy in packs that do not keep once they are opened, the
   * share they use. Null where the measure was not told the packs, and where
   * the weeks buy none.
   */
  packsUsed: number | null;
}

/**
 * What the measure reads of a recipe. The ingredients and what a serving
 * takes of each, where they are known, let it lean on reuse and on the packs
 * as a plan does.
 */
export type ReachRecipe = Pick<
  OptimizerRecipe,
  | 'id'
  | 'mealTypes'
  | 'dietTags'
  | 'caloriesPerServing'
  | 'proteinPerServing'
  | 'fatPerServing'
  | 'carbsPerServing'
> &
  Partial<Pick<OptimizerRecipe, 'ingredientIds' | 'amounts'>>;

/** The weeks a reach is measured on: as many draws, of this many days at this target. */
const REACH = { draws: 5, days: 7, target: 2000 } as const;

/**
 * What the plans of each diet reach of the diet's split, with these recipes:
 * the average day of weeks of three meals, made by the optimiser within the
 * limits of a new profile, which it lets give way where the catalogue leaves
 * no other choice. Null for a diet no such plan can be made for.
 * `perishablePacks` is the pack of each ingredient whose opened pack does not
 * keep, as a plan is given it.
 */
export function macroReachByDiet(
  known: readonly ReachRecipe[],
  perishablePacks?: ReadonlyMap<string, number>,
): Record<DietType, MacroReach | null> {
  const recipes: OptimizerRecipe[] = known.map((recipe) => ({
    ingredientIds: [],
    difficulty: 'easy',
    isFavorite: false,
    totalMinutes: 0,
    ...recipe,
  }));
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const reach = {} as Record<DietType, MacroReach | null>;
  for (const diet of DietType.options) {
    const split = macroSplitOf(diet);
    const sum = { protein: 0, fat: 0, carbs: 0, distance: 0 };
    const packs = { bought: 0, used: 0 };
    let days = 0;
    try {
      for (let seed = 1; seed <= REACH.draws; seed += 1) {
        const { assignments } = optimisePlan({
          recipes,
          days: uniformDays(REACH.days, MEAL_SLOTS_BY_COUNT[3]!, REACH.target),
          macroSplit: split,
          dietType: diet,
          mealPrepFriendly: false,
          maxConsecutiveDaysSameMeal: 2,
          maxTimesPerWeekSameMeal: 3,
          perishablePacks,
          seed,
        });
        if (perishablePacks) {
          const needs = new Map<string, number>();
          for (const placed of assignments) {
            for (const [ingredientId, perServing] of byId.get(placed.recipeId)!.amounts ?? [])
              needs.set(
                ingredientId,
                (needs.get(ingredientId) ?? 0) + perServing * placed.servings,
              );
          }
          const week = packUse(needs, perishablePacks);
          packs.bought += week.bought;
          packs.used += week.used;
        }
        for (let day = 0; day < REACH.days; day += 1) {
          const held = { protein: 0, fat: 0, carbs: 0 };
          for (const placed of assignments.filter((a) => a.dayIndex === day)) {
            const recipe = byId.get(placed.recipeId)!;
            held.protein += recipe.proteinPerServing * placed.servings;
            held.fat += recipe.fatPerServing * placed.servings;
            held.carbs += recipe.carbsPerServing * placed.servings;
          }
          const shares = energyShares(held);
          if (!shares) continue;
          days += 1;
          sum.protein += shares.protein;
          sum.fat += shares.fat;
          sum.carbs += shares.carbs;
          sum.distance += splitDistance(shares, split);
        }
      }
    } catch (err) {
      if (!(err instanceof OptimizerError)) throw err;
      days = 0; // No recipe for one of the meals on this diet.
    }
    reach[diet] =
      days === 0
        ? null
        : {
            protein: sum.protein / days,
            fat: sum.fat / days,
            carbs: sum.carbs / days,
            distance: sum.distance / days,
            packsUsed: packs.bought > 0 ? packs.used / packs.bought : null,
          };
  }
  return reach;
}
