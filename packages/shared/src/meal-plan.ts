// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';
import { AiGenerationMeta } from './ai.js';
import { DietType, DisplayAmount, MealType, Unit } from './enums.js';
import { Ingredient } from './ingredient.js';
import { MAX_CALORIE_TARGET, MIN_CALORIE_TARGET, Macros, Nutrition } from './nutrition.js';
import { Recipe } from './recipe.js';

/**
 * Advanced per-day override. Sparse on purpose: every field is optional and
 * an untouched day sends nothing — the generator falls back to the plan-level
 * defaults. `dayType` carries semantic meaning for the dashboard/stats and for
 * the rebalancer; `useUpBy` biases that day toward recipes that consume
 * expiring inventory; `lockedSlots` pins a recipe to a slot before
 * generating so the rest of the day optimises around it.
 */
export const DayOverride = z.object({
  date: z.string().date(),
  /** Override the meal count for this day only (else the plan-level count). */
  mealCount: z.number().int().min(2).max(5).optional(),
  /** Skip the day entirely — no meals generated, excluded from the shopping list. */
  skip: z.boolean().optional(),
  /** Override the daily calorie target for this day (refeed / rest periodisation). */
  calorieTarget: z.number().int().min(MIN_CALORIE_TARGET).max(MAX_CALORIE_TARGET).optional(),
  /** Semantic tag so a calorie override carries intent (read by the rebalancer and stats). */
  dayType: z.enum(['normal', 'rest', 'training']).optional(),
  /** Hard cap on a recipe's prep+cook minutes for this day (busy weekdays). */
  cookTimeBudgetMinutes: z.number().int().min(0).max(600).optional(),
  /** Bias this day toward recipes that use inventory expiring by this date. */
  useUpBy: z.boolean().optional(),
  /** Pin recipes to slots before generating; the rest of the day fills around them. */
  lockedSlots: z
    .array(z.object({ mealType: MealType, recipeId: z.string().uuid() }))
    .optional(),
});
export type DayOverride = z.infer<typeof DayOverride>;

/**
 * What a refusal with the code `NO_ELIGIBLE_RECIPE` carries under `details`:
 * the meal no recipe was left for, the diet it was wanted for, and how many
 * recipes for the pair the profile's allergens, skipped ingredients and
 * avoided recipes ruled out. None ruled out means there are none to begin with.
 */
export const UnfilledMeal = z.object({
  slot: MealType,
  dietType: DietType,
  ruledOut: z.number().int().min(0),
});
export type UnfilledMeal = z.infer<typeof UnfilledMeal>;

/**
 * A limit of a plan that can give way when no recipe is left for a meal
 * inside it, in the order in which they do: the most a recipe appears in the
 * plan, the day's cooking time, a recipe twice on one day, days in a row, the
 * times a recipe is eaten in seven days, and the most of one ingredient in
 * seven days last.
 */
export const PLAN_RELAXATIONS = ['variety_floor', 'cook_time', 'same_day', 'consecutive_days', 'weekly_cap', 'ingredient_cap'] as const;
export const PlanRelaxation = z.enum(PLAN_RELAXATIONS);
export type PlanRelaxation = z.infer<typeof PlanRelaxation>;

/** A meal that is outside limits of its plan, and which. */
export const RelaxedMeal = z.object({
  date: z.string().date(),
  slot: MealType,
  gaveWay: z.array(PlanRelaxation).min(1),
});
export type RelaxedMeal = z.infer<typeof RelaxedMeal>;

/**
 * What a refusal with the code `PLAN_NEEDS_RELAXATION` carries under
 * `details`: the plan cannot be filled inside its limits. `meals` are the
 * meals that would be outside one if every limit were let give way, and
 * `needs` the limits that would, in the order they do. Sending the request
 * again with `needs` in `allowRelaxations` lets them.
 */
export const RelaxationNeeded = z.object({
  needs: z.array(PlanRelaxation).min(1),
  meals: z.array(RelaxedMeal).min(1),
});
export type RelaxationNeeded = z.infer<typeof RelaxationNeeded>;

/** Request to generate a meal plan. */
export const GeneratePlanRequest = z.object({
  profileId: z.string().uuid(),
  startDate: z.string().date(),
  durationDays: z.number().int().min(1).max(28),
  dietType: DietType.optional(), // defaults to the profile diet type
  mealCount: z.number().int().min(2).max(5).optional(),
  /** Override the profile's calorie target for this plan only. */
  calorieTargetOverride: z.number().int().min(MIN_CALORIE_TARGET).max(MAX_CALORIE_TARGET).optional(),
  /** Bias the optimiser toward batch-cookable, ingredient-reusing plans. */
  mealPrepFriendly: z.boolean().default(false),
  /** Honour the profile's avoid-list (excludedIngredientIds + allergens). */
  respectExclusions: z.boolean().default(true),
  /** Bias the optimiser toward recipes built from the profile's favourites. */
  respectFavorites: z.boolean().default(true),
  /**
   * Bias the optimiser toward recipes the profile's inventory can cover.
   * Default true; auto-no-ops when the pantry is empty so users without
   * inventory see no change. The anti-monotony reset (every N consecutive
   * biased rounds, see Profile.inventoryBiasResetEvery) drops the bias for
   * one round to keep the menu varied.
   */
  respectInventory: z.boolean().default(true),
  /**
   * Variety floor: max total times any one recipe may appear across the
   * whole plan window. Omitted = no floor.
   */
  maxRepeatsPerRecipe: z.number().int().min(1).max(28).optional(),
  /**
   * The limits that may give way when a meal cannot be filled inside them.
   * None by default: the plan is then refused with 422
   * `PLAN_NEEDS_RELAXATION`, which names what would have to.
   */
  allowRelaxations: z.array(PlanRelaxation).default([]),
  /** Per-day advanced overrides (sparse — untouched days are omitted). */
  dayOverrides: z.array(DayOverride).optional(),
});
export type GeneratePlanRequest = z.infer<typeof GeneratePlanRequest>;

/**
 * What a plan was asked for, kept with it so that making it again, or changing
 * a meal of it, asks for the same. `dietType`, `mealCount` and
 * `calorieTargetOverride` are null when the request left them to the profile:
 * the plan then follows the profile as it is when the plan is made again.
 */
export const PlanOptions = z.object({
  dietType: DietType.nullable(),
  mealCount: z.number().int().min(2).max(5).nullable(),
  calorieTargetOverride: z.number().int().nullable(),
  mealPrepFriendly: z.boolean(),
  respectExclusions: z.boolean(),
  respectFavorites: z.boolean(),
  respectInventory: z.boolean(),
  maxRepeatsPerRecipe: z.number().int().nullable(),
  /** The limits that may give way when the plan is made again. */
  allowRelaxations: z.array(PlanRelaxation),
});
export type PlanOptions = z.infer<typeof PlanOptions>;

/**
 * What the pantry had to do with the choice of a plan's recipes: `counted`;
 * `left_out` for variety, in the plan that follows several in a row that
 * counted it; `unused`, when no recipe the plan could choose uses anything
 * that is in it; `empty`; `not_asked`, when the plan was asked to leave it
 * aside.
 */
export const PantryUse = z.enum(['counted', 'left_out', 'unused', 'empty', 'not_asked']);
export type PantryUse = z.infer<typeof PantryUse>;

/**
 * What the generation of a plan had to do to fill it, as far as it still
 * holds: a meal that was changed since is no longer in it.
 */
export const GenerationReport = z.object({
  /** Meals that are outside a limit, because no recipe was left inside it. */
  relaxations: z.array(RelaxedMeal),
  /** Meals for which the diet and the meal left one recipe to choose from. */
  singleCandidate: z.array(z.object({ date: z.string().date(), slot: MealType })),
  pantry: PantryUse,
});
export type GenerationReport = z.infer<typeof GenerationReport>;

/**
 * One ingredient of a planned meal, in the amount this meal uses: the recipe's
 * line scaled by the meal's servings and by the rebalancer's multiplier.
 */
export const PlannedIngredient = z.object({
  ingredientId: z.string().uuid(),
  name: z.string(),
  /** The exact amount, in `unit`. */
  quantity: z.number().min(0),
  unit: Unit,
  /** The amount as it is shown: rounded, in grams, millilitres or pieces of the ingredient. */
  display: DisplayAmount,
  note: z.string().nullable(),
});
export type PlannedIngredient = z.infer<typeof PlannedIngredient>;

/** A single scheduled meal within a plan day. */
export const PlannedMeal = z.object({
  id: z.string().uuid(),
  mealType: MealType,
  /** Null for a user-authored custom meal (it carries no catalogue recipe). */
  recipe: Recipe.nullable(),
  /**
   * What this meal takes of each ingredient. `recipe.ingredients` is the
   * recipe as written, for its own number of servings; these lines are scaled
   * to the meal, so no client has to scale or round. Empty for a custom meal.
   */
  ingredients: z.array(PlannedIngredient),
  /** `CATALOGUE` = from the recipe library; `USER_CUSTOM` = user-authored. */
  source: z.enum(['CATALOGUE', 'USER_CUSTOM']),
  /** Display name for a custom meal (null for catalogue meals — use the recipe). */
  customName: z.string().nullable(),
  /** Baseline servings assigned to this slot (before the rebalancer multiplier). */
  servings: z.number().min(0.25),
  /** Rebalancer multiplier; effective amount = servings * quantityScale. */
  quantityScale: z.number(),
  /** Mark-eaten timestamp, or null. An eaten meal is pinned from rebalancing. */
  eatenAt: z.string().datetime().nullable(),
  /**
   * True when the user swapped in a favourite that does not match the
   * plan's diet type. Derived (recipe.dietTags omits plan.dietType); the UI
   * shows a chip so the dashboard "% on-diet" stat stays honest.
   */
  dietOverride: z.boolean(),
  /**
   * What the profile has ruled out since this meal was planned: an allergen it
   * now avoids, an ingredient it now skips, or the recipe itself marked to
   * avoid. A plan is never rewritten behind the user's back, so the meal stays
   * and says so. Empty for a meal that is still fine, and for a custom meal.
   */
  restrictionConflicts: z.array(z.enum(['allergen', 'excluded_ingredient', 'avoided'])),
  nutrition: Nutrition, // effective: per-serving macros * servings * quantityScale
});
export type PlannedMeal = z.infer<typeof PlannedMeal>;

/** What a re-roll may be told, whether of a plan, of a part of it or of one day. */
const RerollOptions = z.object({
  /** Make days before today again as well. They are left as they are otherwise. */
  includePast: z.boolean().default(false),
  /** Replace the meals marked as eaten. Otherwise they stay, and the rest of their day is filled around them. */
  replaceEaten: z.boolean().default(false),
  /** Replace the user's own meals. Otherwise they stay, and what they hold is counted in their day. */
  replaceCustom: z.boolean().default(false),
  /**
   * Drop a lock whose recipe may no longer go into the plan (it was deleted,
   * or the profile has since ruled it out) instead of refusing the re-roll
   * with `LOCKED_RECIPE_INELIGIBLE`.
   */
  dropIneligibleLocks: z.boolean().default(false),
  /**
   * The limits that may give way this time. Left out: those the plan may
   * let give way already. They are kept with the plan when the whole of it is
   * made again.
   */
  allowRelaxations: z.array(PlanRelaxation).optional(),
});

/** Options of a re-roll of one day of a plan. */
export const RegenerateDayRequest = RerollOptions.prefault({});
export type RegenerateDayRequest = z.infer<typeof RegenerateDayRequest>;

/**
 * Options of a re-roll of a plan. Without `from` and `to` the plan is made
 * again as it was asked for, with the profile as it is now. With either, the
 * days from `from` (the plan's first when left out) to `to` (its last) get
 * other meals and the plan stays what it is: its diet and the targets of its
 * days. Either way the meals that stay, and the days that are not made again,
 * count for the limits of the plan.
 *
 * 400 `RANGE_OUTSIDE_PLAN` when a date is no day of the plan or `from` is
 * after `to`; 409 `NOTHING_TO_REGENERATE` when every day asked for is before
 * today and `includePast` is not set.
 */
export const RegenerateRequest = RerollOptions.extend({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
}).prefault({});
export type RegenerateRequest = z.infer<typeof RegenerateRequest>;

/**
 * The advanced overrides as surfaced on a generated day (the `date` is
 * already on the day row, so it's omitted here). Null when the day used the
 * basic flow. The rebalancer reads `dayType`; the UI renders the rest.
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
  /** What the day aims at of protein, fat and carbohydrate, in grams: its calorie target split as the plan's diet splits a day. */
  targetMacros: Macros,
  /** Signed delta vs. target — positive means over budget. Zero for a skipped day. */
  calorieDelta: z.number(),
  /** The user skips this day: it has no meals, is no shortfall, and is left out of the plan's averages. */
  skipped: z.boolean(),
  /** A target somebody typed, for the plan or for this day, has put the day under the lowest a calculated plan goes. */
  belowSafetyFloor: z.boolean(),
  /** Advanced per-day overrides, or null for a basic-flow day. */
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
  /** Averages over the days that are not skipped, and the optimiser's reuse score (0-1). */
  averageDailyNutrition: Nutrition,
  /** What a day at the plan's own calorie target aims at of protein, fat and carbohydrate, in grams. */
  targetMacros: Macros,
  ingredientReuseScore: z.number().min(0).max(1),
  /** `deterministic` = engine only; `ai_assisted` = AI-drafted + validated. */
  generationMode: z.enum(['deterministic', 'ai_assisted']),
  /** What the plan was asked for. */
  options: PlanOptions,
  /** What its generation had to do; null on a plan made before that was kept. */
  report: GenerationReport.nullable(),
  /**
   * How many times the plan has been changed. A change computed from an older
   * revision is refused with `PLAN_CHANGED`, so a client that sees that code
   * reloads the plan.
   */
  revision: z.number().int().min(0),
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
  /** Bias the swap candidate pool toward recipes the pantry covers. */
  respectInventory: z.boolean().default(true),
  /**
   * "show all my favourites": drop the diet-type filter on the candidate
   * pool. Allergens + meal-type stay enforced. The resulting meal is flagged
   * `dietOverride` so the dashboard on-diet stat stays honest.
   */
  allowOffDiet: z.boolean().default(false),
});
export type SwapMealRequest = z.infer<typeof SwapMealRequest>;

/**
 * Request to AI-rank a meal swap. Body-only; URL carries `planId` and
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
  /** Bias the AI-ranked candidate pool toward pantry-covering recipes. */
  respectInventory: z.boolean().default(true),
});
export type AiSwapMealRequest = z.infer<typeof AiSwapMealRequest>;

/** Request to substitute one ingredient inside a planned recipe. */
export const SwapIngredientRequest = z.object({
  planId: z.string().uuid(),
  plannedMealId: z.string().uuid(),
  fromIngredientId: z.string().uuid(),
  toIngredientId: z.string().uuid(),
  /**
   * Have a model reword the description and the steps around the substitute,
   * in the language of the request: one call on the caller's AI allowance.
   * Off by default: the substitute's name then simply replaces the old one in
   * the text, as it does in every other language either way.
   */
  rewriteWithAi: z.boolean().default(false),
});
export type SwapIngredientRequest = z.infer<typeof SwapIngredientRequest>;

/**
 * Request to AI-rank a replacement ingredient. The engine builds the
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
  /** Bias the AI-ranked candidate pool toward ingredients in the pantry. */
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

// ── Flexible meal plans ─────────────────────────────────────────────────

/**
 * Add a user-authored custom meal to a day. The user owns the macros —
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
 * Explicit rebalance trigger. `day` rebalances the single date. `week` takes
 * the days from `date` (today when it is left out) to the end of that week of
 * the plan, a plan's weeks being counted from its first day: each day that is
 * outside its window is brought back with its own meals, and what it cannot
 * absorb is spread over the others inside their own windows. Days before
 * `date` and skipped days are not touched. `restore` is the undo path:
 * when present the service writes those exact scales verbatim and skips the
 * solver (the toast's "Undo last rebalance" sends the pre-edit `before` map).
 */
export const RebalanceRequest = z.object({
  scope: z.enum(['day', 'week']),
  /** Required for `day`. For `week` the first day that may change; today when left out. */
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

/** Mark a planned meal eaten (`true`) or not eaten (`false`). Repeating a request changes nothing. */
export const SetMealEatenRequest = z.object({ eaten: z.boolean() });
export type SetMealEatenRequest = z.infer<typeof SetMealEatenRequest>;

/**
 * Envelope returned by every edit that may rebalance (swap, custom-add,
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
      /** For `week`: the kcal the days still are off by together after the rebalance; zero when the other days took it all, and for `day`. */
      unabsorbedKcal: z.number(),
      macrosBefore: Nutrition,
      macrosAfter: Nutrition,
    })
    .nullable(),
});
export type RebalanceResult = z.infer<typeof RebalanceResult>;

/**
 * Response envelope: the updated plan plus the AI meta so the UI can render the
 * ✨ badge on success or the localised fallback toast on `aiMeta.fallbackReason`.
 */
export const AiSwapMealResponse = RebalanceResult.extend({ aiMeta: AiGenerationMeta });
export type AiSwapMealResponse = z.infer<typeof AiSwapMealResponse>;

/**
 * The result of applying an ingredient substitution. `aiMeta` is null unless
 * the request asked a model to reword the text; then it says who reworded it,
 * or why the plain replacement stands instead.
 */
export const SwapIngredientResponse = RebalanceResult.extend({ aiMeta: AiGenerationMeta.nullable() });
export type SwapIngredientResponse = z.infer<typeof SwapIngredientResponse>;
