// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';
import { AiGenerationMeta } from './ai.js';
import {
  Allergen,
  CookingMethod,
  Complexity,
  Cuisine,
  DietType,
  Difficulty,
  DisplayAmount,
  MealType,
  Unit,
} from './enums.js';
import { Nutrition } from './nutrition.js';

/**
 * What a recipe may hold, whoever wrote it. The text is plain text: no markup,
 * one line per field. A quantity has a ceiling for one serving, because beyond
 * it the line is a mistake, not an ingredient of a meal.
 */
export const RECIPE_LIMITS = {
  /** Characters. */
  title: 120,
  description: 600,
  step: 300,
  note: 120,
  slug: 80,
  /** How many of each a recipe may have. */
  steps: 25,
  ingredients: 30,
  servings: 12,
  /** Preparing and cooking, each, in minutes. */
  minutes: 480,
  /** Of one ingredient in one serving, in the line's own unit. */
  perServing: { g: 1500, ml: 1500, piece: 20 },
} as const;

/** What the name of an ingredient and its storage hint may hold, in characters. */
export const INGREDIENT_NAME_LIMITS = { name: 120, storageHint: 300 } as const;

/** One ingredient line in a recipe, with an exact quantity. */
export const RecipeIngredient = z.object({
  ingredientId: z.string().uuid(),
  /** Display name of the ingredient, from the curated database. */
  name: z.string(),
  /** Quantity in the given unit; the engine converts to the canonical unit. */
  quantity: z.number().min(0),
  unit: Unit,
  /** The quantity as it is shown: rounded, in grams, millilitres or pieces of the ingredient. */
  display: DisplayAmount,
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
  difficulty: Difficulty,
  allergens: z.array(Allergen),
  /** Per-serving nutrition, recomputed deterministically from the database. */
  nutritionPerServing: Nutrition,
  /** 0-1 score: how reusable this recipe's ingredients are across a plan. */
  reuseScore: z.number().min(0).max(1),
  /**
   * Where the recipe came from. Shared with everybody: `seed`, from the
   * catalogue's data files, and `curated`, approved in this instance's
   * curation queue. The user's own: `ai`, written for them by a model, and
   * `user`, made by them, by hand or by swapping an ingredient.
   */
  origin: z.enum(['seed', 'ai', 'user', 'curated']),
});
export type Recipe = z.infer<typeof Recipe>;

/**
 * Request to draft a new recipe. Every preference field is optional —
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

/** Which page of a list, and how long a page is. */
export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(36),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** What the recipe library is searched by. Each part that is given narrows the result. */
export const RecipeSearchQuery = PageQuery.extend({
  /** Words of the title or the description, in English or in the language of the request. */
  search: z.string().trim().max(200).optional(),
  dietType: DietType.optional(),
  mealType: MealType.optional(),
  maxCalories: z.coerce.number().int().min(1).max(10_000).optional(),
  maxPrepMinutes: z.coerce.number().int().min(1).max(1_440).optional(),
  difficulty: Difficulty.optional(),
});
export type RecipeSearchQuery = z.infer<typeof RecipeSearchQuery>;

/** The most recipes a profile may have marked at a time. */
export const MAX_FAVORITES_PER_PROFILE = 500;

/** How a profile feels about a recipe it marked. */
export const FavoriteSentiment = z.enum(['favorite', 'often', 'avoid']);
export type FavoriteSentiment = z.infer<typeof FavoriteSentiment>;

/** Marks a recipe for a profile. Marking it again replaces what was said before. */
export const AddFavoriteRequest = z.object({
  profileId: z.string().uuid(),
  recipeId: z.string().uuid(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  sentiment: FavoriteSentiment.default('favorite'),
});
export type AddFavoriteRequest = z.infer<typeof AddFavoriteRequest>;

/** The recipes a profile marked, narrowed by words and by meal. */
export const FavoriteListQuery = z.object({
  profileId: z.string().uuid(),
  search: z.string().trim().max(200).optional(),
  mealType: MealType.optional(),
});
export type FavoriteListQuery = z.infer<typeof FavoriteListQuery>;

/** Paginated recipe list — returned by `GET /recipes`. */
export const RecipeSearchPage = z.object({
  items: z.array(Recipe),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type RecipeSearchPage = z.infer<typeof RecipeSearchPage>;
