// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What follows from a recipe's ingredients: its nutrition per serving, the
 * allergens it contains and the diets it qualifies for. This is the only place
 * those three are worked out. Nobody types them: not the data files, not a
 * model, not an admin.
 */
import type { RecipeDietTag, Unit } from '@diet-app/shared';
import { nutritionFor, toCanonical, type ConvertibleIngredient } from './units.js';

/** The part of an ingredient the facts of a recipe depend on. */
export interface FactsIngredient extends ConvertibleIngredient {
  caloriesPer100: number;
  proteinPer100: number;
  fatPer100: number;
  carbsPer100: number;
  allergens: readonly string[];
  dietCompatibility: readonly string[];
}

export interface FactsLine {
  quantity: number;
  unit: Unit;
  ingredient: FactsIngredient;
}

export interface RecipeFacts {
  /** Per serving, rounded to whole kilocalories and grams. */
  perServing: { calories: number; protein: number; fat: number; carbs: number };
  allergens: string[];
  dietTags: RecipeDietTag[];
}

/**
 * The most of a recipe's energy that may come from carbohydrate for it to
 * count as ketogenic or as low-carbohydrate: under about 50 g and 130 g a day
 * at 2,000 kcal, the definitions used in the nutrition literature. A share of
 * energy stays the same when a serving is scaled to a calorie budget, which a
 * number of grams would not. Fibre is not in the data, so all carbohydrate
 * counts.
 */
export const KETO_MAX_CARB_ENERGY = 0.1;
export const LOW_CARB_MAX_CARB_ENERGY = 0.26;

const KCAL_PER_GRAM_OF_CARBOHYDRATE = 4;

/** The diets a recipe qualifies for only when every one of its ingredients does. */
const BY_INGREDIENT: readonly RecipeDietTag[] = ['vegetarian', 'vegan', 'mediterranean'];

/** The allergens of every ingredient, each once, in a fixed order. */
export function allergensOf(lines: readonly Pick<FactsLine, 'ingredient'>[]): string[] {
  return [...new Set(lines.flatMap((line) => line.ingredient.allergens))].sort();
}

/**
 * The facts of a recipe. Throws `UnitConversionError` when a line is written
 * in a unit its ingredient cannot be converted from.
 */
export function recipeFacts(lines: readonly FactsLine[], servings: number): RecipeFacts {
  const total = { calories: 0, protein: 0, fat: 0, carbs: 0 };
  for (const { quantity, unit, ingredient } of lines) {
    const n = nutritionFor(toCanonical(quantity, unit, ingredient), {
      calories: ingredient.caloriesPer100,
      protein: ingredient.proteinPer100,
      fat: ingredient.fatPer100,
      carbs: ingredient.carbsPer100,
    });
    total.calories += n.calories;
    total.protein += n.protein;
    total.fat += n.fat;
    total.carbs += n.carbs;
  }

  const dietTags: RecipeDietTag[] = [];
  // A recipe without ingredients, or without energy, qualifies for nothing.
  if (lines.length > 0 && total.calories > 0) {
    for (const diet of BY_INGREDIENT) {
      if (lines.every((line) => line.ingredient.dietCompatibility.includes(diet))) dietTags.push(diet);
    }
    const carbEnergy = (total.carbs * KCAL_PER_GRAM_OF_CARBOHYDRATE) / total.calories;
    if (carbEnergy <= LOW_CARB_MAX_CARB_ENERGY) dietTags.push('low_carb');
    if (carbEnergy <= KETO_MAX_CARB_ENERGY) dietTags.push('keto');
  }

  const perServing = (value: number): number => Math.round(value / servings);
  return {
    perServing: {
      calories: perServing(total.calories),
      protein: perServing(total.protein),
      fat: perServing(total.fat),
      carbs: perServing(total.carbs),
    },
    allergens: allergensOf(lines),
    dietTags,
  };
}
