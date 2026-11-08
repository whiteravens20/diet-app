// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What the weight of the pantry term in the optimiser's score does to plans that waste less, on a
 * catalogue: for each diet and each weight, with the packs weighed as "less waste" weighs them, how
 * much of a pantry a week uses, how much of what it buys in packs that do not keep, how many of those
 * packs it leaves more than a fifth of, how far its days are from the diet's split, and how many
 * different recipes it holds. The first row is a plan as it is made without "less waste". Each draw
 * stocks the pantry with ingredients of the diet's recipes, a few servings' worth of each. The weight
 * of "less waste" was chosen from this table; run it again when the catalogue has grown.
 *
 *   npx tsx scripts/tune-pantry-weight.ts [data directory]
 */
import { join } from 'node:path';
import { DietType, fitsDiet, MEAL_SLOTS_BY_COUNT } from '@diet-app/shared';
import { readCatalogue } from '../src/admin/seed/catalogue.js';
import { energyShares, macroSplitOf, splitDistance } from '../src/engine/nutrition.js';
import {
  optimisePlan,
  recipeCoverage,
  SCORE_WEIGHTS,
  uniformDays,
} from '../src/engine/optimizer.js';
import { packUse } from '../src/engine/packs.js';
import { plannable } from './catalogue-plans.js';

/** The pack weight "less waste" plans with, chosen with `tune-pack-weight.ts`. */
const LESS_WASTE_PACKS = 0.6;
const WEIGHTS = [0.1, 0.2, 0.3, 0.45, 0.6, 0.8];
const SEEDS = 20;
const DAYS = 7;
const TARGET = 2000;
/** How many ingredients a pantry holds, and how many servings' worth of each, at most. */
const STOCKED = 8;
const MOST_SERVINGS = 4;

const dataDir = process.argv[2] ?? join(__dirname, '../../../data');
const { catalogue, problems } = readCatalogue(dataDir);
if (!catalogue) {
  console.error(
    `The data in ${dataDir} does not load: ${problems.length} problem(s). Run the data lint.`,
  );
  process.exit(1);
}

const { recipes, perishablePacks } = plannable(catalogue);
const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

/** A draw that is the same every run: a linear congruential generator from the seed. */
function drawn(seed: number): () => number {
  let state = seed * 2654435761;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** A pantry of the diet's ingredients: each one a few servings' worth of what a recipe takes of it. */
function pantryOf(diet: DietType, seed: number): Map<string, number> {
  const random = drawn(seed);
  const perServing = new Map<string, number>();
  for (const recipe of recipes) {
    if (!fitsDiet(recipe.dietTags, diet)) continue;
    for (const [ingredientId, quantity] of recipe.amounts ?? [])
      perServing.set(ingredientId, Math.max(perServing.get(ingredientId) ?? 0, quantity));
  }
  const ingredients = [...perServing.keys()].sort();
  const stock = new Map<string, number>();
  while (stock.size < Math.min(STOCKED, ingredients.length)) {
    const ingredientId = ingredients[Math.floor(random() * ingredients.length)]!;
    if (stock.has(ingredientId)) continue;
    stock.set(
      ingredientId,
      perServing.get(ingredientId)! * (1 + Math.floor(random() * MOST_SERVINGS)),
    );
  }
  return stock;
}

console.log(
  `${recipes.length} recipes and ${perishablePacks.size} packs that do not keep, from ${dataDir}; weeks of ${TARGET} kcal, the limits of a new profile, ${SEEDS} draws for each of three, four and five meals a day, a pantry of ${STOCKED} of the diet's ingredients at 1 to ${MOST_SERVINGS} servings' worth each\n`,
);
for (const diet of DietType.options.filter((option) => option !== 'custom')) {
  const split = macroSplitOf(diet);
  console.log(diet);
  console.log(
    '  pantry weight   pantry used %   packs used %   left more than a fifth of   off the split   recipes in a week',
  );
  for (const [label, weights] of [
    ['now', SCORE_WEIGHTS] as const,
    ...WEIGHTS.map(
      (pantry) =>
        [
          pantry.toFixed(2),
          { ...SCORE_WEIGHTS, packs: LESS_WASTE_PACKS, inventoryCoverage: pantry },
        ] as const,
    ),
  ]) {
    let stocked = 0;
    let taken = 0;
    let bought = 0;
    let used = 0;
    let wasted = 0;
    let off = 0;
    let days = 0;
    let distinct = 0;
    let plans = 0;
    for (const meals of [3, 4, 5]) {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const pantry = pantryOf(diet, seed * 7 + meals);
        const coverage = new Map(
          recipes.map((recipe) => [
            recipe.id,
            recipeCoverage(
              [...(recipe.amounts ?? [])].map(([ingredientId, canonicalQuantity]) => ({
                ingredientId,
                canonicalQuantity,
              })),
              pantry,
            ),
          ]),
        );
        let result;
        try {
          result = optimisePlan(
            {
              recipes,
              days: uniformDays(DAYS, MEAL_SLOTS_BY_COUNT[meals]!, TARGET),
              macroSplit: split,
              dietType: diet,
              mealPrepFriendly: false,
              maxConsecutiveDaysSameMeal: 2,
              maxTimesPerWeekSameMeal: 3,
              perishablePacks,
              inventoryCoverage: coverage,
              seed,
            },
            weights,
          );
        } catch {
          continue; // No recipe for one of the meals on this diet.
        }
        plans += 1;
        distinct += new Set(result.assignments.map((placed) => placed.recipeId)).size;
        const needs = new Map<string, number>();
        for (const placed of result.assignments) {
          for (const [ingredientId, perServing] of byId.get(placed.recipeId)!.amounts ?? [])
            needs.set(ingredientId, (needs.get(ingredientId) ?? 0) + perServing * placed.servings);
        }
        for (const [ingredientId, held] of pantry) {
          stocked += held;
          taken += Math.min(held, needs.get(ingredientId) ?? 0);
        }
        // What the week buys is what the pantry does not hold.
        const toBuy = new Map(
          [...needs].map(([ingredientId, need]) => [
            ingredientId,
            Math.max(0, need - (pantry.get(ingredientId) ?? 0)),
          ]),
        );
        const week = packUse(toBuy, perishablePacks);
        bought += week.bought;
        used += week.used;
        wasted += week.open.filter((pack) => pack.wasted).length;
        for (let day = 0; day < DAYS; day += 1) {
          const held = { protein: 0, fat: 0, carbs: 0 };
          for (const placed of result.assignments.filter((a) => a.dayIndex === day)) {
            const recipe = byId.get(placed.recipeId)!;
            held.protein += recipe.proteinPerServing * placed.servings;
            held.fat += recipe.fatPerServing * placed.servings;
            held.carbs += recipe.carbsPerServing * placed.servings;
          }
          const shares = energyShares(held);
          if (!shares) continue;
          days += 1;
          off += splitDistance(shares, split);
        }
      }
    }
    if (plans === 0) {
      console.log(`  ${label.padStart(13)}   no plan can be made`);
      continue;
    }
    console.log(
      `  ${label.padStart(13)}   ${`${Math.round((100 * taken) / stocked)}`.padStart(13)}   ${(bought > 0 ? `${Math.round((100 * used) / bought)}` : '-').padStart(12)}   ${(wasted / plans).toFixed(1).padStart(25)}   ${(off / days).toFixed(3).padStart(13)}   ${(distinct / plans).toFixed(1).padStart(17)}`,
    );
  }
  console.log('');
}
