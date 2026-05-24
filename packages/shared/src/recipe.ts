import { z } from 'zod';
import { Allergen, DietType, MealType, Unit } from './enums.js';
import { Nutrition } from './nutrition.js';

/** One ingredient line in a recipe, with an exact quantity. */
export const RecipeIngredient = z.object({
  ingredientId: z.string().uuid(),
  /** Display name of the ingredient, from the curated database. */
  name: z.string(),
  /** Quantity in the given unit; the engine converts to the canonical unit. */
  quantity: z.number().min(0),
  unit: Unit,
  /** g per piece — when present, UIs render the line in grams. */
  gramsPerPiece: z.number().min(0).nullable().default(null),
  /** Optional free-text note, e.g. "diced", "to taste". */
  note: z.string().nullable().default(null),
});
export type RecipeIngredient = z.infer<typeof RecipeIngredient>;

/**
 * A recipe. Nutrition is always **derived** from `ingredients` against the
 * curated database — it is never authored directly, including by AI.
 */
export const Recipe = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  servings: z.number().int().min(1),
  mealTypes: z.array(MealType),
  dietTags: z.array(DietType),
  ingredients: z.array(RecipeIngredient).min(1),
  steps: z.array(z.string()).min(1),
  prepMinutes: z.number().int().min(0),
  cookMinutes: z.number().int().min(0),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  allergens: z.array(Allergen),
  /** Per-serving nutrition, recomputed deterministically from the database. */
  nutritionPerServing: Nutrition,
  /** 0-1 score: how reusable this recipe's ingredients are across a plan. */
  reuseScore: z.number().min(0).max(1),
  /** `seed` = curated; `ai` = AI-drafted then validated; `user` = user-created. */
  origin: z.enum(['seed', 'ai', 'user']),
});
export type Recipe = z.infer<typeof Recipe>;
