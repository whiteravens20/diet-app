import { z } from 'zod';
import { AiGenerationMeta } from './ai.js';
import {
  Allergen,
  CookingMethod,
  Complexity,
  Cuisine,
  DietType,
  MealType,
  Unit,
} from './enums.js';
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
  /**
   * `seed` = curated baseline from data/recipes.json; `ai` = AI-drafted then
   * validated; `user` = user-created (incl. ingredient-swap variants);
   * `curated` = promoted from an AI_USER draft, ships into data/recipes/
   * promoted.json so the next re-seed makes it permanent.
   */
  origin: z.enum(['seed', 'ai', 'user', 'curated']),
});
export type Recipe = z.infer<typeof Recipe>;

/**
 * Request to draft a new recipe (F20). Every preference field is optional —
 * an empty request lets the AI pick freely from the catalogue. There is no
 * free-text prompt field: user input is constrained to structured filters
 * so the model can't be prompt-injected, and the catalogue slug-resolution
 * invariant stays intact.
 *
 * The filters are **soft preferences**, not hard constraints. The backend
 * builds the prompt to bias the model toward the chosen cuisine / cooking
 * method / favourite ingredients / etc., but the model is always allowed
 * to fall back to the broader eligible catalogue when the filter
 * intersection is too narrow. The only hard rules are: allergens are
 * always excluded, every returned ingredient slug must resolve against the
 * live `Ingredient` table, the engine recomputes nutrition.
 */
export const AiDraftRecipeRequest = z.object({
  profileId: z.string().uuid(),
  /** Optional bias toward a specific meal slot. */
  mealType: MealType.optional(),
  /** Optional bias toward a diet type. Defaults to the profile's dietType. */
  dietType: DietType.optional(),
  /** Optional cuisine hint. */
  cuisine: Cuisine.optional(),
  /** Optional cooking-method hint. */
  cookingMethod: CookingMethod.optional(),
  /** Optional complexity band. */
  complexity: Complexity.optional(),
  /** Optional per-serving kcal target (200-1200). */
  kcalTarget: z.number().int().min(200).max(1200).optional(),
  /** Optional cap on prep + cook minutes (5-120). */
  prepTimeMaxMinutes: z.number().int().min(5).max(120).optional(),
  /**
   * When true, the prompt highlights the profile's `favoriteIngredientIds`
   * as preferred picks (soft bias — not a hard constraint).
   */
  useFavoriteIngredients: z.boolean().default(false),
  /**
   * When true, the profile's `excludedIngredientIds` are removed from the
   * eligible catalogue before the prompt is built. Allergens are always
   * excluded regardless of this flag.
   */
  respectExclusions: z.boolean().default(true),
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
