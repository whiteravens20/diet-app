import { z } from 'zod';
import { AiGenerationMeta } from './ai.js';
import { DietType, MealType } from './enums.js';
import { Ingredient } from './ingredient.js';
import { Macros, Nutrition } from './nutrition.js';
import { Recipe } from './recipe.js';

/**
 * F17 advanced per-day override. Sparse on purpose: every field is optional and
 * an untouched day sends nothing — the generator falls back to the plan-level
 * defaults. `dayType` carries semantic meaning for the dashboard/stats and for
 * F22's rebalancer; `useUpBy` biases that day toward recipes that consume
 * expiring inventory (F15 compose); `lockedSlots` pins a recipe to a slot before
 * generating so the rest of the day optimises around it.
 */
export const DayOverride = z.object({
  date: z.string().date(),
  /** Override the meal count for this day only (else the plan-level count). */
  mealCount: z.number().int().min(2).max(5).optional(),
  /** Skip the day entirely — no meals generated, excluded from the shopping list. */
  skip: z.boolean().optional(),
  /** Override the daily calorie target for this day (refeed / rest periodisation). */
  calorieTarget: z.number().int().min(800).max(6000).optional(),
  /** Semantic tag so a calorie override carries intent (read by F22 + stats). */
  dayType: z.enum(['normal', 'rest', 'training']).optional(),
  /** Hard cap on a recipe's prep+cook minutes for this day (busy weekdays). */
  cookTimeBudgetMinutes: z.number().int().min(0).max(600).optional(),
  /** F15: bias this day toward recipes that use inventory expiring by this date. */
  useUpBy: z.boolean().optional(),
  /** Pin recipes to slots before generating; the rest of the day fills around them. */
  lockedSlots: z
    .array(z.object({ mealType: MealType, recipeId: z.string().uuid() }))
    .optional(),
});
export type DayOverride = z.infer<typeof DayOverride>;

/** Request to generate a meal plan. */
export const GeneratePlanRequest = z.object({
  profileId: z.string().uuid(),
  startDate: z.string().date(),
  durationDays: z.number().int().min(1).max(28),
  dietType: DietType.optional(), // defaults to the profile diet type
  mealCount: z.number().int().min(2).max(5).optional(),
  /** Override the profile's calorie target for this plan only. */
  calorieTargetOverride: z.number().int().min(800).max(6000).optional(),
  /** Bias the optimiser toward batch-cookable, ingredient-reusing plans. */
  mealPrepFriendly: z.boolean().default(false),
  /** Honour the profile's avoid-list (excludedIngredientIds + allergens). */
  respectExclusions: z.boolean().default(true),
  /** Bias the optimiser toward recipes built from the profile's favourites. */
  respectFavorites: z.boolean().default(true),
  /**
   * F15 bias the optimiser toward recipes the profile's inventory can cover.
   * Default true; auto-no-ops when the pantry is empty so users without
   * inventory see no change. The anti-monotony reset (every N consecutive
   * biased rounds, see Profile.inventoryBiasResetEvery) drops the bias for
   * one round to keep the menu varied.
   */
  respectInventory: z.boolean().default(true),
  /**
   * F17 variety floor: max total times any one recipe may appear across the
   * whole plan window. Omitted = no floor. Persisted on the plan so
   * `regenerate` re-applies it.
   */
  maxRepeatsPerRecipe: z.number().int().min(1).max(28).optional(),
  /** F17 per-day advanced overrides (sparse — untouched days are omitted). */
  dayOverrides: z.array(DayOverride).optional(),
});
export type GeneratePlanRequest = z.infer<typeof GeneratePlanRequest>;

/** A single scheduled meal within a plan day. */
export const PlannedMeal = z.object({
  id: z.string().uuid(),
  mealType: MealType,
  recipe: Recipe,
  /** Servings of the recipe assigned to this slot. */
  servings: z.number().min(0.25),
  nutrition: Nutrition, // recipe.nutritionPerServing * servings
});
export type PlannedMeal = z.infer<typeof PlannedMeal>;

/**
 * The F17 advanced overrides as surfaced on a generated day (the `date` is
 * already on the day row, so it's omitted here). Null when the day used the
 * basic flow. F22 reads `dayType`; the UI renders the rest.
 */
export const MealPlanDayOverrides = DayOverride.omit({ date: true });
export type MealPlanDayOverrides = z.infer<typeof MealPlanDayOverrides>;

/** One day of a plan. */
export const MealPlanDay = z.object({
  id: z.string().uuid(),
  date: z.string().date(),
  meals: z.array(PlannedMeal),
  dayNutrition: Nutrition, // sum of meal nutrition
  calorieTarget: z.number(),
  /** Signed delta vs. target — positive means over budget. */
  calorieDelta: z.number(),
  /** F17 advanced per-day overrides, or null for a basic-flow day. */
  overrides: MealPlanDayOverrides.nullable(),
});
export type MealPlanDay = z.infer<typeof MealPlanDay>;

/** A full multi-day meal plan. */
export const MealPlan = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  startDate: z.string().date(),
  durationDays: z.number().int(),
  dietType: DietType,
  days: z.array(MealPlanDay),
  /** Plan-wide averages and the optimiser's reuse score (0-1). */
  averageDailyNutrition: Nutrition,
  targetMacros: Macros,
  ingredientReuseScore: z.number().min(0).max(1),
  /** `deterministic` = engine only; `ai_assisted` = AI-drafted + validated. */
  generationMode: z.enum(['deterministic', 'ai_assisted']),
  createdAt: z.string().datetime(),
});
export type MealPlan = z.infer<typeof MealPlan>;

/** Request to swap a planned meal for an alternative. */
export const SwapMealRequest = z.object({
  planId: z.string().uuid(),
  plannedMealId: z.string().uuid(),
  /**
   * `random` — any recipe from the same diet+slot.
   * `favorite` — caller picks one of the profile's favourited recipes (id below).
   * `favorite_ingredients` — random pick biased to recipes that use the profile's
   *   favourite ingredients (highest overlap wins, ties broken deterministically).
   */
  strategy: z.enum(['random', 'favorite', 'favorite_ingredients']),
  favoriteRecipeId: z.string().uuid().optional(),
  /** F15 bias the swap candidate pool toward recipes the pantry covers. */
  respectInventory: z.boolean().default(true),
});
export type SwapMealRequest = z.infer<typeof SwapMealRequest>;

/**
 * Request to AI-rank a meal swap (F20). Body-only; URL carries `planId` and
 * `plannedMealId`. The engine builds the candidate set deterministically and
 * AI picks one — never the other way around (nutrition is never invented).
 */
export const AiSwapMealRequest = z.object({
  planId: z.string().uuid(),
  plannedMealId: z.string().uuid(),
  /**
   * Optional free-form user hint surfaced in the prompt
   * (e.g. *"something lighter"*, *"more protein"*, *"no fish today"*).
   * Capped to keep the prompt cost predictable.
   */
  hint: z.string().trim().max(200).optional(),
  /** F15 bias the AI-ranked candidate pool toward pantry-covering recipes. */
  respectInventory: z.boolean().default(true),
});
export type AiSwapMealRequest = z.infer<typeof AiSwapMealRequest>;

/**
 * Response envelope: the updated plan plus the AI meta so the UI can render the
 * ✨ badge on success or the localised fallback toast on `aiMeta.fallbackReason`.
 */
export const AiSwapMealResponse = z.object({
  plan: MealPlan,
  aiMeta: AiGenerationMeta,
});
export type AiSwapMealResponse = z.infer<typeof AiSwapMealResponse>;

/** Request to substitute one ingredient inside a planned recipe. */
export const SwapIngredientRequest = z.object({
  planId: z.string().uuid(),
  plannedMealId: z.string().uuid(),
  fromIngredientId: z.string().uuid(),
  toIngredientId: z.string().uuid(),
});
export type SwapIngredientRequest = z.infer<typeof SwapIngredientRequest>;

/**
 * Request to AI-rank a replacement ingredient (F20). The engine builds the
 * candidate pool — same category as the source line, diet/allergen-safe — and
 * AI picks one. The UI then runs the existing preview/apply pipeline on the
 * AI's pick, so nutrition is recomputed by the engine end-to-end.
 */
export const AiSuggestIngredientRequest = z.object({
  planId: z.string().uuid(),
  plannedMealId: z.string().uuid(),
  fromIngredientId: z.string().uuid(),
  /** Optional free-form user hint, e.g. *"cheaper"*, *"higher protein"*. */
  hint: z.string().trim().max(200).optional(),
  /** F15 bias the AI-ranked candidate pool toward ingredients in the pantry. */
  respectInventory: z.boolean().default(true),
});
export type AiSuggestIngredientRequest = z.infer<typeof AiSuggestIngredientRequest>;

/**
 * Response envelope: the AI's chosen replacement ingredient id and the meta.
 * The caller runs `/meal-plans/swap-ingredient/preview` + `/apply` with this id
 * so nutrition stays engine-owned. `aiMeta.fallbackReason` surfaces the
 * localised toast when AI was unavailable and the pick is deterministic.
 */
export const AiSuggestIngredientResponse = z.object({
  toIngredient: Ingredient,
  aiMeta: AiGenerationMeta,
});
export type AiSuggestIngredientResponse = z.infer<typeof AiSuggestIngredientResponse>;

/** The before/after delta surfaced to the user before confirming a swap. */
export const SwapPreview = z.object({
  before: Nutrition,
  after: Nutrition,
  calorieDelta: z.number(),
  macroDelta: Macros,
  /** Adjusted quantity of the replacement ingredient, canonical units. */
  adjustedQuantity: z.number().optional(),
  explanation: z.string(),
  /** False if the swap would violate diet/allergen constraints. */
  valid: z.boolean(),
});
export type SwapPreview = z.infer<typeof SwapPreview>;
