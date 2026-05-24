import { z } from 'zod';
import { DietType, MealType } from './enums.js';
import { Macros, Nutrition } from './nutrition.js';
import { Recipe } from './recipe.js';

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

/** One day of a plan. */
export const MealPlanDay = z.object({
  id: z.string().uuid(),
  date: z.string().date(),
  meals: z.array(PlannedMeal),
  dayNutrition: Nutrition, // sum of meal nutrition
  calorieTarget: z.number(),
  /** Signed delta vs. target — positive means over budget. */
  calorieDelta: z.number(),
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
});
export type SwapMealRequest = z.infer<typeof SwapMealRequest>;

/** Request to substitute one ingredient inside a planned recipe. */
export const SwapIngredientRequest = z.object({
  planId: z.string().uuid(),
  plannedMealId: z.string().uuid(),
  fromIngredientId: z.string().uuid(),
  toIngredientId: z.string().uuid(),
});
export type SwapIngredientRequest = z.infer<typeof SwapIngredientRequest>;

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
