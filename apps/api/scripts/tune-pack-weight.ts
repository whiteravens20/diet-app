// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What the weight of the pack term in the optimiser's score does to plans, on
 * a catalogue: for each diet and each weight, how much the weeks use of what
 * they buy in packs that do not keep, how many packs they open and how many
 * of those they leave more than a fifth of, how far their days are from
 * the diet's split, and how many different recipes a week holds. The weight
 * in `SCORE_WEIGHTS` was chosen from this table; run it again when the
 * catalogue has grown.
 *
 *   npx tsx scripts/tune-pack-weight.ts [data directory]
 */
import { join } from 'node:path';
import { DietType, MEAL_SLOTS_BY_COUNT } from '@diet-app/shared';
import { readCatalogue } from '../src/admin/seed/catalogue.js';
import { energyShares, macroSplitOf, splitDistance } from '../src/engine/nutrition.js';
import { optimisePlan, SCORE_WEIGHTS, uniformDays } from '../src/engine/optimizer.js';
import { packUse } from '../src/engine/packs.js';
import { plannable } from './catalogue-plans.js';

const WEIGHTS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4];
const SEEDS = 20;
const DAYS = 7;
const TARGET = 2000;

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

console.log(
  `${recipes.length} recipes and ${perishablePacks.size} packs that do not keep, from ${dataDir}; weeks of ${TARGET} kcal, the limits of a new profile, ${SEEDS} draws for each of three, four and five meals a day\n`,
);
for (const diet of DietType.options.filter((option) => option !== 'custom')) {
  const split = macroSplitOf(diet);
  console.log(diet);
  console.log(
    '  weight   packs used %   packs opened   left more than a fifth of   off the split   recipes in a week',
  );
  for (const packs of WEIGHTS) {
    let bought = 0;
    let used = 0;
    let opened = 0;
    let wasted = 0;
    let off = 0;
    let days = 0;
    let distinct = 0;
    let plans = 0;
    for (const meals of [3, 4, 5]) {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
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
              maxIngredientPerWeek: 3000,
              perishablePacks,
              seed,
            },
            { ...SCORE_WEIGHTS, packs },
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
        const week = packUse(needs, perishablePacks);
        bought += week.bought;
        used += week.used;
        opened += week.open.length;
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
      console.log(`  ${packs.toFixed(2).padStart(6)}   no plan can be made`);
      continue;
    }
    console.log(
      `  ${packs.toFixed(2).padStart(6)}   ${(bought > 0 ? `${Math.round((100 * used) / bought)}` : '-').padStart(12)}   ${(opened / plans).toFixed(1).padStart(12)}   ${(wasted / plans).toFixed(1).padStart(30)}   ${(off / days).toFixed(3).padStart(13)}   ${(distinct / plans).toFixed(1).padStart(17)}`,
    );
  }
  console.log('');
}
