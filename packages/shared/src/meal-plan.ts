// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { AiGenerationMeta, ModelPickNote } from './ai.js';
import { CalendarDay, dayAfter, DietType, DisplayAmount, LAST_DAY, MealType, Unit } from './enums.js';
import { Ingredient } from './ingredient.js';
import { EnteredNutrition, MAX_CALORIE_TARGET, MIN_CALORIE_TARGET, Macros, Nutrition } from './nutrition.js';
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
  date: CalendarDay,
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
    .max(MealType.options.length)
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

/** The longest a plan may be, in days, and the most meals such a plan holds. */
export const MAX_PLAN_DAYS = 28;
export const MAX_PLAN_MEALS = MAX_PLAN_DAYS * MealType.options.length;

/** Request to generate a meal plan. */
export const GeneratePlanRequest = z.object({
  profileId: z.string().uuid(),
  startDate: CalendarDay,
  durationDays: z.number().int().min(1).max(MAX_PLAN_DAYS),
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
  allowRelaxations: z.array(PlanRelaxation).max(PLAN_RELAXATIONS.length).default([]),
  /** Per-day advanced overrides (sparse — untouched days are omitted). */
  dayOverrides: z.array(DayOverride).max(MAX_PLAN_DAYS).optional(),
}).superRefine((request, ctx) => {
  // A first day outside the years there are is refused where it stands; what follows is about a plan that begins inside them.
  if (request.startDate > LAST_DAY) return;
  const lastDay = dayAfter(request.startDate, request.durationDays - 1);
  if (lastDay > LAST_DAY) ctx.addIssue({ code: 'custom', path: ['durationDays'], message: `The plan would run past ${LAST_DAY}.` });
  const named = new Set<string>();
  request.dayOverrides?.forEach((day, index) => {
    const at = ['dayOverrides', index];
    if (named.has(day.date)) ctx.addIssue({ code: 'custom', path: [...at, 'date'], message: 'This day is named twice.' });
    named.add(day.date);
    if (day.date < request.startDate || day.date > lastDay) ctx.addIssue({ code: 'custom', path: [...at, 'date'], message: 'This is no day of the plan.' });
    if (day.skip && (day.lockedSlots?.length ?? 0) > 0) ctx.addIssue({ code: 'custom', path: [...at, 'lockedSlots'], message: 'A day that is skipped has no meal to lock.' });
    const locked = new Set<string>();
    day.lockedSlots?.forEach((lock, slot) => {
      if (locked.has(lock.mealType)) ctx.addIssue({ code: 'custom', path: [...at, 'lockedSlots', slot, 'mealType'], message: 'This meal is locked twice.' });
      locked.add(lock.mealType);
    });
  });
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
  /**
   * Set when a model chose this recipe for the meal, out of what the engine
   * allowed: the reason it gave, when it gave one. Null when the engine
   * chose, or the user did.
   */
  modelPick: z.object({ reason: z.string().max(200).nullable() }).nullable(),
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
  allowRelaxations: z.array(PlanRelaxation).max(PLAN_RELAXATIONS.length).optional(),
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
  from: CalendarDay.optional(),
  to: CalendarDay.optional(),
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

/** Where a plan stands on a day: under way, over, or still to begin. */
export const PlanStatus = z.enum(['active', 'past', 'upcoming']);
export type PlanStatus = z.infer<typeof PlanStatus>;

/**
 * A plan as a list shows it: what it is and what a day of it holds on
 * average, without its days. `GET /meal-plans/:id` answers the whole plan.
 */
export const MealPlanSummary = MealPlan.omit({ days: true, report: true, targetMacros: true });
export type MealPlanSummary = z.infer<typeof MealPlanSummary>;

/**
 * Which plans of a profile to list, the one that begins last first. Each part
 * that is given narrows the list. `status` goes by the day it is for the
 * client (the header `X-Client-Date`).
 */
export const PlanListQuery = z.object({
  profileId: z.string().uuid(),
  /** Plans that hold this day or a later one. */
  from: CalendarDay.optional(),
  /** Plans that begin on this day or before it. */
  to: CalendarDay.optional(),
  status: PlanStatus.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type PlanListQuery = z.infer<typeof PlanListQuery>;

/** A page of the list of plans. */
export const MealPlanPage = z.object({
  items: z.array(MealPlanSummary),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type MealPlanPage = z.infer<typeof MealPlanPage>;

/**
 * Which recipe to offer in the place of a planned meal. Nothing is written:
 * the answer is a `MealSwapPreview`, and `ApplyMealSwapRequest` makes the swap.
 */
export const SwapMealRequest = z.object({
  planId: z.string().uuid(),
  plannedMealId: z.string().uuid(),
  /**
   * `random` — any recipe for the meal and the plan's diet.
   * `favorite` — one of the profile's favourites, which the caller names (id below).
   * `favorite_ingredients` — of those recipes, the ones that use the most of
   *   the profile's favourite ingredients.
   * The first and the last offer only recipes that hold, at their best
   * serving, within 15 % of the energy the meal holds now.
   */
  strategy: z.enum(['random', 'favorite', 'favorite_ingredients']),
  favoriteRecipeId: z.string().uuid().optional(),
  /** Offer first what the pantry covers. */
  respectInventory: z.boolean().default(true),
  /**
   * "show all my favourites": the diet of the plan is no bar, and for a
   * favourite picked by hand neither is the meal it is for. Allergens,
   * skipped ingredients and the avoid mark hold. The meal is then flagged
   * `dietOverride`.
   */
  allowOffDiet: z.boolean().default(false),
  /** Recipes offered for this meal already in this sitting: the next offer is none of them while another is left. */
  skip: z.array(z.string().uuid()).max(100).default([]),
})
  // A favourite is asked for by its recipe.
  .refine((request) => request.strategy !== 'favorite' || request.favoriteRecipeId !== undefined, {
    path: ['favoriteRecipeId'],
    message: 'Name the favourite recipe to swap in.',
  });
export type SwapMealRequest = z.infer<typeof SwapMealRequest>;

/**
 * Ask a model which recipe to offer in the place of a planned meal. The engine
 * decides what the model may choose from, never the other way round; nothing
 * is written.
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
  /** Put before the model first what the pantry covers. */
  respectInventory: z.boolean().default(true),
  /** Recipes offered for this meal already in this sitting. */
  skip: z.array(z.string().uuid()).max(100).default([]),
});
export type AiSwapMealRequest = z.infer<typeof AiSwapMealRequest>;

/**
 * A recipe offered in the place of a planned meal, and what the swap would do,
 * before anything is written.
 */
export const MealSwapPreview = z.object({
  recipe: Recipe,
  /** How many servings of it the meal would be: as many as come nearest to what the meal holds now. */
  servings: z.number(),
  /** What the meal holds now, and what it would hold. */
  before: Nutrition,
  after: Nutrition,
  /** What the day holds now and what it would hold, before its other meals are balanced around the new one. */
  dayBefore: Nutrition,
  dayAfter: Nutrition,
  /** What the day aims at. */
  calorieTarget: z.number(),
  /** The revision of the plan the offer was made from: sent back to make the swap. */
  revision: z.number().int().min(0),
});
export type MealSwapPreview = z.infer<typeof MealSwapPreview>;

/**
 * An offer a model was asked for: `aiMeta` says who picked, or why the engine
 * did. `pick` is the note of a model's pick, to hand back when the offer is
 * taken; null when the engine picked.
 */
export const AiMealSwapPreview = MealSwapPreview.extend({ aiMeta: AiGenerationMeta, pick: ModelPickNote.nullable() });
export type AiMealSwapPreview = z.infer<typeof AiMealSwapPreview>;

/**
 * Make a swap that was offered: the recipe of a `MealSwapPreview`, on the plan
 * as it was then. A plan that changed since answers 409 `PLAN_CHANGED`. The
 * recipe is judged again before it is written.
 */
export const ApplyMealSwapRequest = z.object({
  planId: z.string().uuid(),
  plannedMealId: z.string().uuid(),
  recipeId: z.string().uuid(),
  revision: z.number().int().min(0).max(2_147_483_647),
  /** How the offer was asked for; `random` for one a model picked. A `favorite` is not held to the energy of the meal it replaces. */
  strategy: z.enum(['random', 'favorite', 'favorite_ingredients']),
  allowOffDiet: z.boolean().default(false),
  /**
   * The note that came with an offer a model picked. The meal then says that
   * a model chose its recipe. 400 `MODEL_PICK_INVALID` for a note that is not
   * for this recipe on this meal of the plan as it stands, or has run out.
   */
  pick: ModelPickNote.optional(),
});
export type ApplyMealSwapRequest = z.infer<typeof ApplyMealSwapRequest>;

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
  /**
   * Make the substitution although it moves what a serving of the recipe
   * holds, its energy or its protein, fat or carbohydrate, by more than a
   * tenth. Without it such a substitution is refused with 422
   * `SUBSTITUTION_MOVES_NUTRITION`, whose `details.moved` names what moves.
   */
  acceptChange: z.boolean().default(false),
  /**
   * The note that came with a substitute a model suggested. The recipe the
   * substitution makes then says that a model had a part in it. 400
   * `MODEL_PICK_INVALID` for a note that is not for this substitution.
   */
  pick: ModelPickNote.optional(),
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
 * `pick` is the note of a model's pick, to hand back when the substitution is
 * made; null when the engine picked.
 */
export const AiSuggestIngredientResponse = z.object({
  toIngredient: Ingredient,
  aiMeta: AiGenerationMeta,
  pick: ModelPickNote.nullable(),
});
export type AiSuggestIngredientResponse = z.infer<typeof AiSuggestIngredientResponse>;

/**
 * A substitute the catalogue's own rules name for an ingredient of a planned
 * meal: the one of them that may come into this plan and changes a serving
 * least. `moved` says what of a serving it would move by more than a tenth all
 * the same.
 */
export const SubstituteSuggestion = z.object({
  fromIngredientId: z.string().uuid(),
  to: Ingredient,
  moved: z.array(z.enum(['calories', 'protein', 'fat', 'carbs'])),
});
export type SubstituteSuggestion = z.infer<typeof SubstituteSuggestion>;

/** Why a substitution may not be made: what the recipe it would leave may not be, for this plan's profile. */
export const SubstitutionViolation = z.enum(['off_diet', 'allergen', 'excluded_ingredient']);
export type SubstitutionViolation = z.infer<typeof SubstitutionViolation>;

/** What of a serving a substitution moves by more than a tenth. */
export const MovedNutrient = z.enum(['calories', 'protein', 'fat', 'carbs']);
export type MovedNutrient = z.infer<typeof MovedNutrient>;

/**
 * What a substitution would do to the meal it is made in, before anything is
 * written. Every figure is for the meal as it is planned, the portion on the
 * plate, not for the recipe as it is written.
 */
export const SwapPreview = z.object({
  before: Nutrition,
  after: Nutrition,
  calorieDelta: z.number(),
  macroDelta: Macros,
  /** What the meal takes of the ingredient that leaves, all its lines together. */
  from: PlannedIngredient,
  /** What it would take of the one that comes in its place. */
  to: PlannedIngredient,
  /**
   * How the amount of the substitute was decided: as much as holds the same
   * `energy`; `capped` at three times the amount it replaces; or the same
   * amount (`mass`), where one of the two holds no energy to go by.
   */
  sizing: z.enum(['energy', 'capped', 'mass']),
  /** The recipe has the substitute already: its amount grows, and no second line is written. */
  merged: z.boolean(),
  /** Why the substitution may not be made; empty when it may. */
  violations: z.array(SubstitutionViolation),
  /** What of a serving moves by more than a tenth: applying then needs `acceptChange`. */
  moved: z.array(MovedNutrient),
  /** No violation stands in the way. */
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
  nutrition: EnteredNutrition,
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
  date: CalendarDay.optional(),
  restore: z
    .array(z.object({ mealId: z.string().uuid(), scale: z.number().min(0).max(10) }))
    .max(MAX_PLAN_MEALS)
    .optional(),
})
  // One day is rebalanced by its date; an undo names its meals instead.
  .refine((request) => request.scope !== 'day' || request.date !== undefined || (request.restore?.length ?? 0) > 0, {
    path: ['date'],
    message: 'Name the day to rebalance.',
  })
  .refine((request) => new Set(request.restore?.map((entry) => entry.mealId)).size === (request.restore?.length ?? 0), {
    path: ['restore'],
    message: 'A meal is put back once.',
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
 * The result of applying an ingredient substitution. `aiMeta` is null unless
 * the request asked a model to reword the text; then it says who reworded it,
 * or why the plain replacement stands instead.
 */
export const SwapIngredientResponse = RebalanceResult.extend({ aiMeta: AiGenerationMeta.nullable() });
export type SwapIngredientResponse = z.infer<typeof SwapIngredientResponse>;
