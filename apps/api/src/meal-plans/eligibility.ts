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
import { BadRequestException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
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

/**
 * What the user may waive by asking for it explicitly: the diet of the plan
 * ("show me all my favourites") and, for one favourite they picked by hand,
 * the meal it is meant for. Nothing else can be waived.
 */
export interface Waived {
  diet?: boolean;
  meal?: boolean;
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
  if (!waived.meal && !recipe.mealTypes.includes(meal)) found.push('wrong_meal');
  if (!waived.diet && !fitsDiet(recipe.dietTags, restrictions.diet)) found.push('off_diet');
  if (recipe.allergens.some((allergen) => restrictions.allergens.includes(allergen))) found.push('allergen');
  if (recipe.ingredients.some((line) => restrictions.excludedIngredientIds.includes(line.ingredientId))) {
    found.push('excluded_ingredient');
  }
  if (restrictions.avoidedRecipeIds.includes(recipe.id)) found.push('avoided');
  return found;
}

/**
 * The query condition for the recipes `violations` would let through, less the
 * ones in `except` (the recipe being replaced, for a swap).
 */
export function poolWhere(
  restrictions: Restrictions,
  meal: string,
  waived: Waived = {},
  except: readonly string[] = [],
): Prisma.RecipeWhereInput {
  return {
    deletedAt: null,
    retiredAt: null,
    OR: [{ createdByUserId: null }, { createdByUserId: restrictions.userId }],
    ...(waived.meal ? {} : { mealTypes: { has: meal } }),
    ...(waived.diet ? {} : recipesForDiet(restrictions.diet)),
    NOT: { allergens: { hasSome: [...restrictions.allergens] } },
    ingredients: { none: { ingredientId: { in: [...restrictions.excludedIngredientIds] } } },
    id: { notIn: [...restrictions.avoidedRecipeIds, ...except] },
  };
}

/** The restrictions of a plan, read from its profile as the profile is now. */
export async function restrictionsFor(
  db: Pick<PrismaClient, 'favorite'>,
  plan: {
    dietType: string;
    profileId: string;
    profile: {
      userId: string;
      preferences: { allergens: string[]; excludedIngredientIds: string[] } | null;
    };
  },
): Promise<Restrictions> {
  const avoided = await db.favorite.findMany({
    where: { profileId: plan.profileId, sentiment: 'avoid' },
    select: { recipeId: true },
  });
  return {
    userId: plan.profile.userId,
    diet: plan.dietType as DietType,
    allergens: plan.profile.preferences?.allergens ?? [],
    excludedIngredientIds: plan.profile.preferences?.excludedIngredientIds ?? [],
    avoidedRecipeIds: avoided.map((row) => row.recipeId),
  };
}

const REASON: Record<Violation, string> = {
  not_available: 'it is not available to this account',
  wrong_meal: 'it is not a recipe for this meal',
  off_diet: "it does not fit the plan's diet",
  allergen: 'it contains an allergen the profile avoids',
  excluded_ingredient: 'it contains an ingredient the profile skips',
  avoided: 'it is marked to be avoided',
};

/**
 * The gate itself: refuse to go on when `recipe` may not be written into the
 * plan. `error` is the code the caller's route answers with.
 */
export function assertMayEnter(
  recipe: Candidate,
  restrictions: Restrictions,
  meal: string,
  error: string,
  waived: Waived = {},
): void {
  const found = violations(recipe, restrictions, meal, waived);
  if (found.length === 0) return;
  throw new BadRequestException({
    error,
    message: `This recipe cannot go into the plan: ${found.map((violation) => REASON[violation]).join('; ')}.`,
    violations: found,
  });
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
