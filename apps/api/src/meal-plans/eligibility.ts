// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The one answer to "may this recipe go into this plan".
 *
 * A plan belongs to a profile, and the profile says what must stay out of it:
 * a diet, allergens, ingredients to skip, recipes marked "avoid". Everything
 * that writes a recipe into a plan asks here, twice: `poolWhere` builds the
 * query for candidates, and `violations` judges the one recipe that was picked
 * immediately before it is written. Both come from the same `Restrictions`,
 * so a path cannot filter by one rule and forget another.
 */
import type { Prisma } from '@prisma/client';
import { fitsDiet, type DietType } from '@diet-app/shared';
import { recipesForDiet } from '../recipes/diet-where.js';

/** What a profile's plan must never contain, and whose recipes it may use. */
export interface Restrictions {
  /** The owner of the plan: shared recipes and their own are visible to them. */
  userId: string;
  diet: DietType;
  allergens: readonly string[];
  excludedIngredientIds: readonly string[];
  /** Recipes the profile marked "avoid". */
  avoidedRecipeIds: readonly string[];
}

/** Why a recipe may not go into a plan. */
export type Violation = 'not_available' | 'wrong_meal' | 'off_diet' | 'allergen' | 'excluded_ingredient' | 'avoided';

/** What the user may waive by asking for one recipe explicitly. Nothing else can be. */
export interface Waived {
  /** The diet of the plan and the meal the recipe is meant for. */
  dietAndMeal?: boolean;
}

/** The part of a recipe the gate reads. */
export interface Candidate {
  id: string;
  mealTypes: readonly string[];
  dietTags: readonly string[];
  allergens: readonly string[];
  createdByUserId: string | null;
  deletedAt: Date | null;
  retiredAt: Date | null;
  ingredients: readonly { ingredientId: string }[];
}

/** The columns to load for a `Candidate`. */
export const CANDIDATE = {
  id: true,
  mealTypes: true,
  dietTags: true,
  allergens: true,
  createdByUserId: true,
  deletedAt: true,
  retiredAt: true,
  ingredients: { select: { ingredientId: true } },
} satisfies Prisma.RecipeSelect;

/** Every reason `recipe` may not be planned as `meal` under `restrictions`; empty when it may. */
export function violations(
  recipe: Candidate,
  restrictions: Restrictions,
  meal: string,
  waived: Waived = {},
): Violation[] {
  const found: Violation[] = [];
  const visible = recipe.createdByUserId === null || recipe.createdByUserId === restrictions.userId;
  if (!visible || recipe.deletedAt !== null || recipe.retiredAt !== null) found.push('not_available');
  if (!waived.dietAndMeal) {
    if (!recipe.mealTypes.includes(meal)) found.push('wrong_meal');
    if (!fitsDiet(recipe.dietTags, restrictions.diet)) found.push('off_diet');
  }
  if (recipe.allergens.some((allergen) => restrictions.allergens.includes(allergen))) found.push('allergen');
  if (recipe.ingredients.some((line) => restrictions.excludedIngredientIds.includes(line.ingredientId))) {
    found.push('excluded_ingredient');
  }
  if (restrictions.avoidedRecipeIds.includes(recipe.id)) found.push('avoided');
  return found;
}

/** The query condition for the recipes `violations` would let through. */
export function poolWhere(restrictions: Restrictions, meal: string, waived: Waived = {}): Prisma.RecipeWhereInput {
  return {
    deletedAt: null,
    retiredAt: null,
    OR: [{ createdByUserId: null }, { createdByUserId: restrictions.userId }],
    ...(waived.dietAndMeal ? {} : { mealTypes: { has: meal }, ...recipesForDiet(restrictions.diet) }),
    NOT: { allergens: { hasSome: [...restrictions.allergens] } },
    ingredients: { none: { ingredientId: { in: [...restrictions.excludedIngredientIds] } } },
    id: { notIn: [...restrictions.avoidedRecipeIds] },
  };
}

/**
 * A position in a list of `size`, the same for the same `key` every time.
 * FNV-1a in 32-bit integer arithmetic: a floating-point multiply here would
 * round away the low bits and favour even positions.
 */
export function pickIndex(key: string, size: number): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
  }
  return hash % size;
}
