// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Deterministic ingredient substitution: how much of one ingredient takes the
 * place of another, and what the substitution does to a serving. Whether the
 * substitute may enter the plan at all is the plan's gate to say
 * (`meal-plans/eligibility.ts`), which judges the recipe the substitution
 * makes.
 */
import type { Allergen, DietType, Nutrition, ProductCategory, Unit } from '@diet-app/shared';
import type { ConvertibleIngredient } from './units.js';

export interface EngineIngredient extends ConvertibleIngredient {
  id: string;
  name: string;
  category: ProductCategory;
  canonicalUnit: Unit;
  caloriesPer100: number;
  proteinPer100: number;
  fatPer100: number;
  carbsPer100: number;
  allergens: Allergen[];
  dietCompatibility: DietType[];
}

/** The most of a substitute, as a multiple of the amount it takes the place of. */
export const MAX_SUBSTITUTE_RATIO = 3;

/**
 * How the amount of a substitute was decided: as much as holds the same
 * `energy`; `capped` at three times the amount it replaces; or the same
 * amount (`mass`), where one of the two holds no energy to go by.
 */
export type SubstituteSizing = 'energy' | 'capped' | 'mass';

/**
 * How much of `to` takes the place of `amount` of `from`, each in its own unit
 * (grams or millilitres). It is as much as holds the same energy, and never
 * more than three times what it replaces: energy is not all that a spoonful
 * of oil and a pan of spinach differ in.
 */
export function substituteAmount(
  from: Pick<EngineIngredient, 'caloriesPer100'>,
  to: Pick<EngineIngredient, 'caloriesPer100'>,
  amount: number,
): { amount: number; sizing: SubstituteSizing } {
  if (from.caloriesPer100 <= 0 || to.caloriesPer100 <= 0) return { amount, sizing: 'mass' };
  const matching = (amount * from.caloriesPer100) / to.caloriesPer100;
  const most = amount * MAX_SUBSTITUTE_RATIO;
  return matching > most ? { amount: most, sizing: 'capped' } : { amount: matching, sizing: 'energy' };
}

/** A substitution may move what a serving holds by this share without being asked about. */
export const SUBSTITUTION_TOLERANCE = 0.1;

/** A change that is no more than this is no move, whatever share of the serving it is. */
const TOO_LITTLE_TO_COUNT: Nutrition = { calories: 10, protein: 2, fat: 2, carbs: 2 };

export type NutritionKey = keyof Nutrition;
const KEYS: readonly NutritionKey[] = ['calories', 'protein', 'fat', 'carbs'];

/**
 * What of a serving a substitution moves by more than a tenth: its energy, or
 * its protein, fat or carbohydrate. A change of a gram or two is not counted,
 * so that a recipe with next to none of something is not held to a tenth of it.
 */
export function movedBy(before: Nutrition, after: Nutrition): NutritionKey[] {
  return KEYS.filter((key) => {
    const change = Math.abs(after[key] - before[key]);
    return change > TOO_LITTLE_TO_COUNT[key] && change > before[key] * SUBSTITUTION_TOLERANCE;
  });
}
