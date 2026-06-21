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
  /** Null for an F22 user-authored custom meal (it carries no catalogue recipe). */
  recipe: Recipe.nullable(),
  /** F22 `CATALOGUE` = from the recipe library; `USER_CUSTOM` = user-authored. */
  source: z.enum(['CATALOGUE', 'USER_CUSTOM']),
  /** Display name for a custom meal (null for catalogue meals — use the recipe). */
  customName: z.string().nullable(),
  /** Baseline servings assigned to this slot (before the rebalancer multiplier). */
  servings: z.number().min(0.25),
  /** F22 rebalancer multiplier; effective amount = servings * quantityScale. */
  quantityScale: z.number(),
  /** F22 mark-eaten timestamp, or null. An eaten meal is pinned from rebalancing. */
  eatenAt: z.string().datetime().nullable(),
  /**
   * F22(a): true when the user swapped in a favourite that does not match the
   * plan's diet type. Derived (recipe.dietTags omits plan.dietType); the UI
   * shows a chip so the dashboard "% on-diet" stat stays honest.
   */
  dietOverride: z.boolean(),
  nutrition: Nutrition, // effective: per-serving macros * servings * quantityScale
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
  /**
   * F22(a) "show all my favourites": drop the diet-type filter on the candidate
   * pool. Allergens + meal-type stay enforced. The resulting meal is flagged
   * `dietOverride` so the dashboard on-diet stat stays honest.
   */
  allowOffDiet: z.boolean().default(false),
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

// ── F22 flexible meal plans ─────────────────────────────────────────────────

/**
 * F22(b) add a user-authored custom meal to a day. The user owns the macros —
 * we don't recompute them from an ingredient list, because a custom meal has
 * none. `nutrition` is frozen on the row as entered.
 */
export const AddCustomMealRequest = z.object({
  /** Free-text name for the meal (e.g. "Mum's lasagne"). */
  name: z.string().trim().min(1).max(120),
  mealType: MealType,
  /** User-entered macros for one serving. Engine never recomputes these. */
  nutrition: Nutrition,
  servings: z.number().min(0.25).max(20).default(1),
});
export type AddCustomMealRequest = z.infer<typeof AddCustomMealRequest>;

/**
 * F22(c) explicit rebalance trigger. `day` rebalances the single date; `week`
 * shares the surplus/deficit across the plan week. `restore` is the undo path:
 * when present the service writes those exact scales verbatim and skips the
 * solver (the toast's "Undo last rebalance" sends the pre-edit `before` map).
 */
export const RebalanceRequest = z.object({
  scope: z.enum(['day', 'week']),
  /** Required for `day` scope; for `week` it selects which week to rebalance. */
  date: z.string().date().optional(),
  restore: z
    .array(z.object({ mealId: z.string().uuid(), scale: z.number().min(0) }))
    .optional(),
});
export type RebalanceRequest = z.infer<typeof RebalanceRequest>;

/** A single meal's quantity-scale change produced by a rebalance. */
export const RebalanceChange = z.object({
  mealId: z.string().uuid(),
  before: z.number(),
  after: z.number(),
});
export type RebalanceChange = z.infer<typeof RebalanceChange>;

/**
 * Envelope returned by every F22 edit that may rebalance (swap, custom-add,
 * eaten toggle, explicit rebalance). Carries the updated plan plus the rebalance
 * summary the UI renders as a toast (macro delta + per-meal scale) and uses to
 * offer "Undo last rebalance" via `changes[].before`.
 */
export const RebalanceResult = z.object({
  plan: MealPlan,
  rebalance: z
    .object({
      scope: z.enum(['day', 'week']),
      feasibility: z.enum(['in-window', 'best-effort']),
      changes: z.array(RebalanceChange),
      macrosBefore: Nutrition,
      macrosAfter: Nutrition,
    })
    .nullable(),
});
export type RebalanceResult = z.infer<typeof RebalanceResult>;
