// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * How a day's energy falls among its meals in the plans a catalogue makes: for
 * each level of waste, each target and each count of meals, the share of the
 * day each meal takes as it is eaten, how often dinner comes out larger than
 * lunch and by how much, how far the days are from the diet's split, how much
 * of what the weeks buy in packs that do not keep they use, and how many
 * different recipes a week holds. The planner gives lunch a dish that reaches
 * its part of the day and the sizing keeps dinner no larger than lunch
 * (`dinnerToLunch`); this is how often that holds. Each week is made as the
 * application makes it: placed, sized, and in a plan that wastes less its
 * packs closed and their rests given to the meals. All diets but the custom
 * one; run it again when the catalogue has grown.
 *
 *   npx tsx scripts/measure-meal-shares.ts [data directory]
 */
import { join } from 'node:path';
import { DietType, MEAL_SLOTS_BY_COUNT, type MealType } from '@diet-app/shared';
import { readCatalogue } from '../src/admin/seed/catalogue.js';
import { closePacks } from '../src/engine/close-packs.js';
import { distanceOnDiet, energyShares, MACROS_OFF, macroSplitOf } from '../src/engine/nutrition.js';
import { optimisePlan, SCORE_WEIGHTS, uniformDays } from '../src/engine/optimizer.js';
import { packRests } from '../src/engine/pack-rests.js';
import { packUse, type Pack } from '../src/engine/packs.js';
import { sizeAssignments } from '../src/engine/rebalance.js';
import { LESS_WASTE, NO_WASTE, type WasteLevel } from '../src/engine/waste-levels.js';
import { dailyNeeds, plannable } from './catalogue-plans.js';

const TARGETS = [1500, 2000, 2800];
const SEEDS = 20;
const DAYS = 7;

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
const ingredientOf = new Map(
  catalogue.ingredients.map((ingredient) => [ingredient.slug, ingredient]),
);
const energyPer100 = new Map(
  catalogue.ingredients.map((ingredient) => [ingredient.slug, ingredient.caloriesPer100]),
);
/** The packs as a level plans with them (eaten within its days), or as a kitchen keeps them; frozen where it freezes them. */
const packsOf = (level: WasteLevel | null, planned: boolean): Map<string, Pack> =>
  new Map(
    [...perishablePacks].map(([id, pack]) => {
      const ingredient = ingredientOf.get(id) ?? {};
      return [
        id,
        {
          ...pack,
          ...(level?.freezes?.(ingredient) ? { freezes: true } : {}),
          ...(level && planned ? { keepDays: level.keepDays(ingredient) } : {}),
        },
      ];
    }),
  );
const DIETS = DietType.options.filter((option) => option !== 'custom');
const LEVELS: { label: string; level: WasteLevel | null }[] = [
  { label: 'plain', level: null },
  { label: 'less waste', level: LESS_WASTE },
  { label: 'no waste', level: NO_WASTE },
];
const percent = (part: number, whole: number) =>
  whole === 0 ? '-' : `${Math.round((100 * part) / whole)}`;

console.log(
  `${recipes.length} recipes and ${perishablePacks.size} packs that do not keep, from ${dataDir}; weeks of each target, the limits of a new profile, ${SEEDS} draws for each diet and count of meals\n`,
);
console.log(
  '  level        kcal meals  shares (meals in order)   dinner > lunch %   by over 5 points %   largest lead   off the split   off its macros %   packs used %   recipes in a week',
);
for (const { label, level } of LEVELS) {
  const planned = packsOf(level, true);
  const kitchen = packsOf(level, false);
  const consecutive = Math.max(2, level?.repeats?.daysInARow ?? 0);
  const perWeek = Math.max(3, level?.repeats?.timesAWeek ?? 0);
  const twiceADay = level?.repeats?.twiceADay ?? false;
  for (const target of TARGETS) {
    for (const meals of [3, 4, 5]) {
      const slots = MEAL_SLOTS_BY_COUNT[meals]!;
      const shares = new Map<MealType, number>(slots.map((slot) => [slot, 0]));
      let days = 0;
      let over = 0;
      let overFive = 0;
      let lead = 0;
      let off = 0;
      let offMacros = 0;
      let bought = 0;
      let used = 0;
      let distinct = 0;
      let plans = 0;
      for (const diet of DIETS) {
        const split = macroSplitOf(diet);
        for (let seed = 1; seed <= SEEDS; seed += 1) {
          const week = uniformDays(DAYS, slots, target);
          let result;
          try {
            result = optimisePlan(
              {
                recipes,
                days: week,
                macroSplit: split,
                dietType: diet,
                mealPrepFriendly: false,
                maxConsecutiveDaysSameMeal: consecutive,
                maxTimesPerWeekSameMeal: perWeek,
                twiceADay,
                perishablePacks: planned,
                seed,
              },
              level?.weights ?? SCORE_WEIGHTS,
            );
          } catch {
            continue; // No recipe for one of the meals on this diet.
          }
          const sized = sizeAssignments(week, recipes, result.assignments, split);
          const closed = level
            ? closePacks({
                plans: [
                  {
                    recipes,
                    days: week,
                    assignments: sized,
                    split,
                    dietType: diet,
                    mealPrepFriendly: false,
                    limits: { consecutive, perWeek, twiceADay },
                  },
                ],
                packs: planned,
                splitSlack: level.splitSlack,
              })[0]!
            : sized;
          const rests = level
            ? packRests({
                plans: [{ recipes, days: week, assignments: closed, mealPrepFriendly: false }],
                packs: planned,
                energyPer100,
                caps: level.rests,
              })[0]!
            : new Map<number, { ingredientId: string; amount: number }[]>();
          // Each meal as it is eaten: its servings at the portion its day is sized to, with the rests it finishes.
          const eaten = closed.map((meal, index) => ({
            ...meal,
            servings: meal.servings * meal.quantityScale,
            rests: rests.get(index) ?? [],
          }));
          plans += 1;
          distinct += new Set(eaten.map((meal) => meal.recipeId)).size;
          for (let day = 0; day < DAYS; day += 1) {
            const energy = new Map<MealType, number>();
            const held = { protein: 0, fat: 0, carbs: 0 };
            for (const meal of eaten.filter((one) => one.dayIndex === day)) {
              const recipe = byId.get(meal.recipeId)!;
              let kcal = recipe.caloriesPerServing * meal.servings;
              held.protein += recipe.proteinPerServing * meal.servings;
              held.fat += recipe.fatPerServing * meal.servings;
              held.carbs += recipe.carbsPerServing * meal.servings;
              for (const rest of meal.rests) {
                const food = ingredientOf.get(rest.ingredientId);
                if (!food) continue;
                kcal += (food.caloriesPer100 * rest.amount) / 100;
                held.protein += (food.proteinPer100 * rest.amount) / 100;
                held.fat += (food.fatPer100 * rest.amount) / 100;
                held.carbs += (food.carbsPer100 * rest.amount) / 100;
              }
              energy.set(meal.slot, (energy.get(meal.slot) ?? 0) + kcal);
            }
            const total = [...energy.values()].reduce((sum, kcal) => sum + kcal, 0);
            if (total <= 0) continue;
            days += 1;
            for (const slot of slots)
              shares.set(slot, shares.get(slot)! + (energy.get(slot) ?? 0) / total);
            if (slots.includes('lunch')) {
              const gap = ((energy.get('dinner') ?? 0) - (energy.get('lunch') ?? 0)) / total;
              if (gap > 0) over += 1;
              if (gap > 0.05) overFive += 1;
              lead = Math.max(lead, gap);
            }
            const balance = energyShares(held);
            if (balance) {
              const away = distanceOnDiet(balance, split, diet);
              off += away;
              if (away > MACROS_OFF) offMacros += 1;
            }
          }
          // What the week buys: the meals at their servings, the rests on their meal's day, the packs as a kitchen keeps them.
          const needs = dailyNeeds(eaten, byId, DAYS);
          for (const meal of eaten)
            for (const rest of meal.rests) {
              const row = needs.get(rest.ingredientId);
              if (row) row[meal.dayIndex]! += rest.amount;
            }
          const counted = packUse(needs, kitchen);
          bought += counted.bought;
          used += counted.used;
        }
      }
      if (days === 0) {
        console.log(
          `  ${label.padEnd(10)} ${`${target}`.padStart(6)} ${meals}      no plan can be made`,
        );
        continue;
      }
      const inOrder = slots.map((slot) => Math.round((100 * shares.get(slot)!) / days)).join('/');
      console.log(
        `  ${label.padEnd(10)} ${`${target}`.padStart(6)} ${meals}      ${inOrder.padEnd(24)} ${percent(over, days).padStart(16)}   ${percent(overFive, days).padStart(18)}   ${`${Math.round(100 * lead)}`.padStart(12)}   ${(off / days).toFixed(3).padStart(13)}   ${percent(offMacros, days).padStart(16)}   ${percent(used, bought).padStart(12)}   ${(distinct / plans).toFixed(1).padStart(17)}`,
      );
    }
  }
}
