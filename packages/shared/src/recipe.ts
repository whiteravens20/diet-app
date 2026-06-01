import { z } from 'zod';
import { AiGenerationMeta } from './ai.js';
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

/**
 * Request to draft a new recipe from a user prompt (F20). AI authors only
 * the textual structure + ingredient choices; the deterministic engine
 * recomputes per-serving nutrition before write. The resulting Recipe row
 * is private to the requesting user (`origin='ai'` + ownership).
 */
export const AiDraftRecipeRequest = z.object({
  profileId: z.string().uuid(),
  /** Free-form description of what the user wants, e.g. *"quick high-protein chicken bowl"*. */
  prompt: z.string().trim().min(3).max(500),
  /** Bias the draft toward a specific meal slot. */
  mealType: MealType.optional(),
  /** Bias the draft toward a diet type. Defaults to the profile's dietType. */
  dietType: DietType.optional(),
  servings: z.number().int().min(1).max(12).optional(),
  /** When true, auto-add the new recipe to the profile's favourites. */
  addToFavorites: z.boolean().default(true),
});
export type AiDraftRecipeRequest = z.infer<typeof AiDraftRecipeRequest>;

/**
 * Response envelope: the persisted Recipe (engine-recomputed nutrition) plus
 * the AI meta. No `fallbackReason` codepath here — drafting from a prompt has
 * no deterministic fallback, so the caller throws if AI is unavailable.
 */
export const AiDraftRecipeResponse = z.object({
  recipe: Recipe,
  aiMeta: AiGenerationMeta,
});
export type AiDraftRecipeResponse = z.infer<typeof AiDraftRecipeResponse>;

/** Paginated recipe list — returned by `GET /recipes`. */
export const RecipeSearchPage = z.object({
  items: z.array(Recipe),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type RecipeSearchPage = z.infer<typeof RecipeSearchPage>;
