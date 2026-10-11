// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What the weight of the macro term in the optimiser's score does to plans,
 * on a catalogue: for each diet and each weight, how far the days of a week
 * are from the diet's split, how many days keep to their calories, and how
 * many different recipes a week holds. The weight in `SCORE_WEIGHTS` was
 * chosen from this table; run it again when the catalogue has grown.
 *
 *   npx tsx scripts/tune-macro-weight.ts [data directory]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DietType, MEAL_SLOTS_BY_COUNT } from '@diet-app/shared';
import { readCatalogue } from '../src/admin/seed/catalogue.js';
import { energyShares, macroSplitOf, splitDistance } from '../src/engine/nutrition.js';
import { optimisePlan, SCORE_WEIGHTS, uniformDays, type OptimizerRecipe } from '../src/engine/optimizer.js';

const WEIGHTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
const SEEDS = 20;
const DAYS = 7;
const TARGET = 2000;

const dataDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const { catalogue, problems } = readCatalogue(dataDir);
if (!catalogue) {
  console.error(`The data in ${dataDir} does not load: ${problems.length} problem(s). Run the data lint.`);
  process.exit(1);
}

const recipes: OptimizerRecipe[] = catalogue.recipes.map((recipe) => ({
  id: recipe.slug,
  mealTypes: recipe.seed.mealTypes,
  dietTags: recipe.dietTags,
  caloriesPerServing: recipe.nutrition.calories,
  proteinPerServing: recipe.nutrition.protein,
  fatPerServing: recipe.nutrition.fat,
  carbsPerServing: recipe.nutrition.carbs,
  ingredientIds: recipe.lines.map((line) => line.slug),
  difficulty: recipe.seed.difficulty,
  isFavorite: false,
  totalMinutes: recipe.seed.prepMinutes + recipe.seed.cookMinutes,
}));
const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
const percent = (share: number) => `${Math.round(share * 100)}`.padStart(3);

console.log(`${recipes.length} recipes from ${dataDir}; weeks of ${TARGET} kcal, the limits of a new profile, ${SEEDS} draws for each of three, four and five meals a day\n`);
for (const diet of DietType.options.filter((option) => option !== 'custom')) {
  const split = macroSplitOf(diet);
  console.log(`${diet}: aims at ${percent(split.protein)} /${percent(split.fat)} /${percent(split.carbs)} % of energy from protein / fat / carbohydrate`);
  console.log('  weight   off the split   protein / fat / carbs %   days inside 10 % of kcal   recipes in a week   meals outside a limit');
  for (const macroFit of WEIGHTS) {
    const off: number[] = [];
    const total = { protein: 0, fat: 0, carbs: 0 };
    let days = 0;
    let inside = 0;
    let distinct = 0;
    let outside = 0;
    let plans = 0;
    for (const meals of [3, 4, 5]) {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        let result;
        try {
          result = optimisePlan(
            { recipes, days: uniformDays(DAYS, MEAL_SLOTS_BY_COUNT[meals]!, TARGET), macroSplit: split, dietType: diet, mealPrepFriendly: false, maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3, maxIngredientPerWeek: 3000, seed },
            { ...SCORE_WEIGHTS, macroFit },
          );
        } catch {
          continue; // No recipe for one of the meals on this diet.
        }
        plans += 1;
        distinct += new Set(result.assignments.map((placed) => placed.recipeId)).size;
        outside += result.report.relaxations.length;
        for (let day = 0; day < DAYS; day += 1) {
          const held = { protein: 0, fat: 0, carbs: 0, calories: 0 };
          for (const placed of result.assignments.filter((a) => a.dayIndex === day)) {
            const recipe = byId.get(placed.recipeId)!;
            held.protein += recipe.proteinPerServing * placed.servings;
            held.fat += recipe.fatPerServing * placed.servings;
            held.carbs += recipe.carbsPerServing * placed.servings;
            held.calories += recipe.caloriesPerServing * placed.servings;
          }
          const shares = energyShares(held);
          if (!shares) continue;
          days += 1;
          off.push(splitDistance(shares, split));
          total.protein += shares.protein;
          total.fat += shares.fat;
          total.carbs += shares.carbs;
          if (Math.abs(held.calories - TARGET) <= TARGET * 0.1) inside += 1;
        }
      }
    }
    if (plans === 0) {
      console.log(`  ${macroFit.toFixed(1).padStart(6)}   no plan can be made`);
      continue;
    }
    const mean = off.reduce((sum, value) => sum + value, 0) / off.length;
    const worst = Math.max(...off);
    console.log(
      `  ${macroFit.toFixed(1).padStart(6)}   ${mean.toFixed(3)} (worst ${worst.toFixed(2)})   ${percent(total.protein / days)} /${percent(total.fat / days)} /${percent(total.carbs / days)}` +
        `              ${percent(inside / days)} %                    ${(distinct / plans).toFixed(1).padStart(5)}               ${(outside / plans).toFixed(1).padStart(5)}`,
    );
  }
  console.log('');
}
