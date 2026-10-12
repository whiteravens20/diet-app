// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
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
/**
 * The address of a page: http or https and nothing else. An address is shown
 * as a link, and `javascript:` is an address too as far as a parser goes.
 */
export const WebAddress = z
  .string()
  .max(500)
  .url()
  .refine((address) => /^https?:\/\//i.test(address), { message: 'An address begins with http:// or https://.' });

/** Where a recipe is from: its address there, when it has one, and its licence. */
export const RecipeSource = z.object({
  url: WebAddress.nullable(),
  license: z.string().min(1).max(200),
});
export type RecipeSource = z.infer<typeof RecipeSource>;

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
  /** The cuisine the recipe belongs to, when it belongs to one. */
  cuisine: Cuisine.nullable(),
  allergens: z.array(Allergen),
  /** Per-serving nutrition, recomputed deterministically from the database. */
  nutritionPerServing: Nutrition,
  /**
   * Where the recipe came from. Shared with everybody: `seed`, from the
   * catalogue's data files, and `curated`, approved in this instance's
   * curation queue. The user's own: `ai`, written for them by a model, and
   * `user`, made by them, by hand or by swapping an ingredient.
   */
  origin: z.enum(['seed', 'ai', 'user', 'curated']),
  /**
   * What a model had to do with the recipe, for the mark it carries wherever
   * it is shown: `written`, a model wrote it for the user (from the
   * catalogue's ingredients, with nutrition the engine computed); `changed`,
   * a recipe of the user's in which a model chose the ingredient that was
   * swapped in, or reworded the text around it; null, nothing.
   */
  byModel: z.enum(['written', 'changed']).nullable(),
  /**
   * Where a recipe that was taken in from somewhere else is from, and the
   * licence it may be passed on under: to be shown with the recipe. Null for
   * a recipe written here.
   */
  source: RecipeSource.nullable(),
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

/** The most ingredients a search of the library may name at once. */
export const MAX_SEARCHED_INGREDIENTS = 10;

/** How a search of the library may be narrowed to what a profile marked. */
export const MarkedFilter = z.enum(['marked', 'often', 'avoid']);
export type MarkedFilter = z.infer<typeof MarkedFilter>;

/** A switch in a query string: `true` is on, `false` and nothing at all are off. */
const querySwitch = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * What the recipe library is searched by. Each part that is given narrows the
 * result; a list is written with commas between its values.
 */
export const RecipeSearchQuery = PageQuery.extend({
  /** Words of the title or the description, in English or in the language of the request. */
  search: z.string().trim().max(200).optional(),
  dietType: DietType.optional(),
  mealType: MealType.optional(),
  maxCalories: z.coerce.number().int().min(1).max(10_000).optional(),
  maxPrepMinutes: z.coerce.number().int().min(1).max(1_440).optional(),
  difficulty: Difficulty.optional(),
  cuisine: Cuisine.optional(),
  /** Ingredients every recipe of the result holds. */
  ingredientIds: z
    .string()
    .max(MAX_SEARCHED_INGREDIENTS * 37)
    .transform((list) => list.split(',').filter(Boolean))
    .pipe(z.array(z.string().uuid()).max(MAX_SEARCHED_INGREDIENTS))
    .optional(),
  /** Allergens no recipe of the result holds. */
  withoutAllergens: z
    .string()
    .max(Allergen.options.length * 20)
    .transform((list) => list.split(',').filter(Boolean))
    .pipe(z.array(Allergen).max(Allergen.options.length))
    .optional(),
  /** What a serving holds, in grams: at least this much protein, at most this much fat and carbohydrate. */
  minProtein: z.coerce.number().min(0).max(500).optional(),
  maxFat: z.coerce.number().min(0).max(500).optional(),
  maxCarbs: z.coerce.number().min(0).max(1000).optional(),
  /**
   * The profile the two parts below are about. `marked` narrows to the
   * recipes the profile marked (`marked`: as a favourite or as eaten often;
   * `often`; `avoid`), `favoriteIngredients` to those that hold one of its
   * favourite ingredients.
   */
  profileId: z.string().uuid().optional(),
  marked: MarkedFilter.optional(),
  favoriteIngredients: querySwitch.optional(),
}).refine((query) => query.profileId !== undefined || (query.marked === undefined && !query.favoriteIngredients), {
  path: ['profileId'],
  message: 'Say whose marks or favourite ingredients are meant.',
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

/** The order a profile's marked recipes are listed in. */
export const FavoriteSort = z.enum(['newest', 'title', 'calories']);
export type FavoriteSort = z.infer<typeof FavoriteSort>;

/**
 * The recipes a profile marked, narrowed by words, by meal, by how they are
 * marked and by a tag, in the order asked for: the mark made last first
 * (`newest`, when nothing is said), by title, or the lightest serving first.
 */
export const FavoriteListQuery = z.object({
  profileId: z.string().uuid(),
  search: z.string().trim().max(200).optional(),
  mealType: MealType.optional(),
  sentiment: FavoriteSentiment.optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  sort: FavoriteSort.default('newest'),
});
export type FavoriteListQuery = z.infer<typeof FavoriteListQuery>;

/** A recipe a profile marked: how, under which tags of the profile's own, and when. */
export const MarkedRecipe = z.object({
  id: z.string().uuid(),
  tags: z.array(z.string()),
  sentiment: FavoriteSentiment,
  markedAt: z.string().datetime(),
  recipe: Recipe,
});
export type MarkedRecipe = z.infer<typeof MarkedRecipe>;

/** Paginated recipe list — returned by `GET /recipes`. */
export const RecipeSearchPage = z.object({
  items: z.array(Recipe),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type RecipeSearchPage = z.infer<typeof RecipeSearchPage>;
