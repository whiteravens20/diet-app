// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { AiGenerationMeta, ModelPickNote } from './ai.js';
import { LAST_DAY, MAX_DIARY_ENTRIES_A_DAY, OWN_MEAL_LIMITS } from './constants.js';
import { DiaryEntry } from './diary.js';
import { CalendarDay, dayAfter, DietType, DisplayAmount, MealType, Unit } from './enums.js';
import { Ingredient } from './ingredient.js';
import {
  EnteredNutrition,
  LabelLimitNote,
  LabelNutrient,
  LabelTotals,
  MacroChange,
  Macros,
  MAX_CALORIE_TARGET,
  MIN_CALORIE_TARGET,
  Nutrition,
} from './nutrition.js';
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
  /**
   * The kind of day: a training day aims about 15 % over a usual day of its
   * week and a rest day about 15 % under, and the days of the week aim at the
   * plan's target on average (`PlanWeek`).
   */
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
 * inside it, in the order in which they do: the meals of seven days that hold
 * the same kind of protein first, then those of one day, so that a kind comes
 * again before a dish does; then the most a recipe appears in the plan, the
 * day's cooking time, a recipe twice on one day, days in a row, and the times
 * a recipe is eaten in seven days last. `ingredient_cap` keeps the name it had
 * when it counted the grams of one ingredient: plans made then hold it.
 */
export const PLAN_RELAXATIONS = [
  'ingredient_cap',
  'kind_same_day',
  'variety_floor',
  'cook_time',
  'same_day',
  'consecutive_days',
  'weekly_cap',
] as const;
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

/** The most plans a profile keeps: two years of a plan a week. A new one is made once an old one is deleted. */
export const MAX_PLANS_PER_PROFILE = 100;

/** The most meals a day of a plan holds when one of the user's own is added: a day the planner makes holds at most five. */
export const MAX_MEALS_ON_A_PLAN_DAY = 20;
export const MAX_PLAN_MEALS = MAX_PLAN_DAYS * MealType.options.length;

/** Request to generate a meal plan. */
export const GeneratePlanRequest = z
  .object({
    profileId: z.string().uuid(),
    startDate: CalendarDay,
    durationDays: z.number().int().min(1).max(MAX_PLAN_DAYS),
    dietType: DietType.optional(), // defaults to the profile diet type
    mealCount: z.number().int().min(2).max(5).optional(),
    /** Override the profile's calorie target for this plan only. */
    calorieTargetOverride: z
      .number()
      .int()
      .min(MIN_CALORIE_TARGET)
      .max(MAX_CALORIE_TARGET)
      .optional(),
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
     * Waste less: lean much harder on what the pantry holds and on finishing
     * the packs that do not keep once opened, at the cost of fewer different
     * recipes in a week and days a little further from their split. Such a
     * plan counts the pantry whatever `respectInventory` says, and is never
     * the round of the rotation that leaves it out; the limits of the profile
     * and of the plan hold as ever. What it does on each diet is in
     * `PublicConfig.plans.lessWaste`. Off by default.
     */
    lessWaste: z.boolean().default(false),
    /**
     * Waste nothing: the stricter level of `lessWaste`, which it takes with it.
     * Every pack is to be used within days (meat and fish within 3 at most,
     * anything else within 5), the same dish may come up to 3 days running, 5
     * times in seven days and twice a day whatever the profile says (its limits
     * on kinds of protein, its allergens, what it avoids and its diet hold), a
     * day may come a little further from its split, and the rest of a pack goes
     * into the meal that finishes it up to as much again as that meal takes and
     * 5 % of the day. What it does on each diet, and its rules, are in
     * `PublicConfig.plans`. Off by default.
     */
    noWaste: z.boolean().default(false),
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
    /**
     * Another profile of the account to plan together with: it gets a plan of
     * its own on the same days, following its own profile (diet, meals a day,
     * calorie target), and at the times of day both have, both plans hold the
     * same dish, a portion sized to each. The two plans are made together, of
     * a joint plan (`MealPlan.joint`), without settings of their days, which
     * each changes in its own plan after. Counted as two makings of a plan.
     */
    withProfileId: z.string().uuid().optional(),
  })
  .superRefine((request, ctx) => {
    if (request.withProfileId === request.profileId)
      ctx.addIssue({
        code: 'custom',
        path: ['withProfileId'],
        message: 'A plan is made together with another profile.',
      });
    if (request.withProfileId && request.dayOverrides?.length)
      ctx.addIssue({
        code: 'custom',
        path: ['dayOverrides'],
        message: 'A joint plan is made without settings of its days: each changes its own after.',
      });
    // A first day outside the years there are is refused where it stands; what follows is about a plan that begins inside them.
    if (request.startDate > LAST_DAY) return;
    const lastDay = dayAfter(request.startDate, request.durationDays - 1);
    if (lastDay > LAST_DAY)
      ctx.addIssue({
        code: 'custom',
        path: ['durationDays'],
        message: `The plan would run past ${LAST_DAY}.`,
      });
    const named = new Set<string>();
    request.dayOverrides?.forEach((day, index) => {
      const at = ['dayOverrides', index];
      if (named.has(day.date))
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'date'],
          message: 'This day is named twice.',
        });
      named.add(day.date);
      if (day.date < request.startDate || day.date > lastDay)
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'date'],
          message: 'This is no day of the plan.',
        });
      if (day.skip && (day.lockedSlots?.length ?? 0) > 0)
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'lockedSlots'],
          message: 'A day that is skipped has no meal to lock.',
        });
      const locked = new Set<string>();
      day.lockedSlots?.forEach((lock, slot) => {
        if (locked.has(lock.mealType))
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'lockedSlots', slot, 'mealType'],
            message: 'This meal is locked twice.',
          });
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
  /** The plan wastes less (see `GeneratePlanRequest.lessWaste`); a plan made before it was offered does not. */
  lessWaste: z.boolean().default(false),
  /** The plan wastes nothing (see `GeneratePlanRequest.noWaste`), and wastes less with it. */
  noWaste: z.boolean().default(false),
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
  /**
   * Of a joint plan, the times of day both have that are planned apart in
   * each plan: no recipe both people may be given was left for them. Empty for
   * every other plan.
   */
  apart: z.array(MealType),
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
  /**
   * Of the amount, what is the rest of a pack that does not keep, which this meal
   * finishes in a plan that wastes less: in `unit`, and as it is shown. Left out
   * where there is none.
   */
  rest: z.object({ quantity: z.number().min(0), display: DisplayAmount }).optional(),
});
export type PlannedIngredient = z.infer<typeof PlannedIngredient>;

/** Another meal of the same cooking, in a plan made for cooking ahead. */
const OtherMealOfCooking = z.object({
  mealId: z.string().uuid(),
  date: z.string().date(),
  mealType: MealType,
  eaten: z.boolean(),
});

/**
 * What a change of a dish does to the other meals of its cooking: those that
 * would get the recipe too where the request says `together`, and those that
 * keep what they hold, for being eaten or of a day that has passed, so that what
 * was cooked for this meal stays unused. Null for a meal cooked for itself.
 */
export const CookingChange = z
  .object({
    changes: z.array(z.object({ date: z.string().date(), mealType: MealType })),
    stays: z.array(z.object({ date: z.string().date(), mealType: MealType })),
  })
  .nullable();
export type CookingChange = z.infer<typeof CookingChange>;

/** The other person's meal of a shared meal, as their plan holds it. */
const OtherPortion = z.object({
  mealId: z.string().uuid(),
  planId: z.string().uuid(),
  profileName: z.string(),
  /** Its servings as eaten: servings times the rebalancer's multiplier. */
  servings: z.number(),
  calories: z.number(),
  eaten: z.boolean(),
});

/**
 * What a meal of a joint plan shares with the other plan: the other person's
 * portion, and what the dish takes in all. `apart` is each portion cooked on
 * its own; otherwise the dish is cooked in one pot and split by weight.
 */
export const SharedMealOf = z.object({
  id: z.string().uuid(),
  apart: z.boolean(),
  with: OtherPortion,
  /** Both portions together, or both cookings where the dish is cooked ahead: what the pot takes. */
  pot: z.array(PlannedIngredient),
});
export type SharedMealOf = z.infer<typeof SharedMealOf>;

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
  /** A macronutrient of a custom meal was left out and estimated. */
  estimated: z.boolean(),
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
   * The ingredients of this meal that the profile would rather not eat, as
   * the profile has them now: the planner found no recipe without one, or the
   * profile came to dislike one since. Empty for a custom meal.
   */
  dislikedIngredientIds: z.array(z.string().uuid()),
  /**
   * Set when a model chose this recipe for the meal, out of what the engine
   * allowed: the reason it gave, when it gave one. Null when the engine
   * chose, or the user did.
   */
  modelPick: z.object({ reason: z.string().max(200).nullable() }).nullable(),
  /**
   * In a plan made for cooking ahead, a dish that is planned twice running is
   * cooked once: `cook` on the meal it is cooked for, which is cooked for the
   * next as well; `cooked` on the meal that is eaten from it, the day after
   * or later the same day. Null for every other meal, and in a plan that was
   * not made for cooking ahead.
   */
  cookAhead: z.enum(['cook', 'cooked']).nullable(),
  /**
   * The other meals of the same cooking, and what the whole of it takes, in the
   * amounts to cook on the meal marked `cook`. Null where `cookAhead` is.
   */
  cooking: z
    .object({
      with: z.array(OtherMealOfCooking),
      ingredients: z.array(PlannedIngredient),
    })
    .nullable(),
  nutrition: Nutrition, // effective: per-serving macros * servings * quantityScale
  /** Fibre, sugars, salt and saturated fat of the meal: nothing of them is known of a meal of one's own. */
  label: LabelTotals,
  /**
   * A meal of a joint plan that both people eat: the same dish at the same day
   * and time of day of the other plan, each with a portion of their own. Null
   * for a meal of this plan alone.
   */
  shared: SharedMealOf.nullable(),
  /**
   * A leftover: what was left of the meal at `mealType` on `date`, eaten here
   * in the place of the dish planned. It is cooked and bought already, so it is
   * never resized, changed, cooked or put on a list. `undoable` while it is not
   * eaten: undoing it brings back the dish it replaced and the meal it was left
   * of. Null for every other meal.
   */
  leftover: z
    .object({ date: z.string().date(), mealType: MealType, undoable: z.boolean() })
    .nullable(),
  /** Where what was left of this meal is eaten, a leftover. Null where nothing of it was carried. */
  carriedTo: z.object({ date: z.string().date(), mealType: MealType }).nullable(),
  /**
   * Whether what is left of this meal can be put in as a meal of the next day:
   * null where it cannot be at all (a meal of one's own, a leftover itself, a
   * meal whose rest was carried already, a meal of a day other than today or
   * yesterday); `ok`, or why the next day cannot take it: no plan holds it
   * (`no_day`), it is skipped (`skipped`), or each of its meals is eaten or a
   * leftover (`no_meal`).
   */
  leftoverOffer: z.enum(['ok', 'no_day', 'skipped', 'no_meal']).nullable(),
  /**
   * What is put on this meal's plate alone beside a dish both people of a joint
   * plan eat, where this person's day would otherwise stay off its split or
   * its calorie target: the food in the amount of this plate, and what it
   * holds. Not in `nutrition`, which is the dish's; the day's figures count it,
   * and so does the diary once the meal is eaten. Null where there is none.
   */
  topping: z
    .object({
      /** Which of the list of toppings it is. */
      key: z.string(),
      ingredient: PlannedIngredient,
      nutrition: Nutrition,
    })
    .nullable(),
});
export type PlannedMeal = z.infer<typeof PlannedMeal>;

/** What a re-roll may be told, whether of a plan, of a part of it or of one day. */
const RerollOptions = z.object({
  /** Make days before today again as well. They are left as they are otherwise. */
  includePast: z.boolean().default(false),
  /**
   * Replace the meals marked as eaten. Otherwise they stay, and the rest of
   * their day is filled around them. A day the user skips keeps them always.
   */
  replaceEaten: z.boolean().default(false),
  /**
   * Replace the user's own meals. Otherwise they stay, and what they hold is
   * counted in their day. A day the user skips keeps them always.
   */
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
  /** The dish a meal gets goes on the meals cooked with it on the days that are not filled again. */
  together: z.boolean().default(false),
  /**
   * Of a plan of a joint plan: the other plan's same days are filled again as
   * well, their meals at the times of day both fill the same dish, shared
   * again. Without it this plan's days are filled again alone, and what they
   * shared is their own from then on.
   */
  forAll: z.boolean().default(false),
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
 * A day the user skips is left as it is. 400 `RANGE_OUTSIDE_PLAN` when a date
 * is no day of the plan or `from` is after `to`; 409 `NOTHING_TO_REGENERATE`
 * when every day asked for is skipped, or before today without `includePast`.
 */
export const RegenerateRequest = RerollOptions.extend({
  from: CalendarDay.optional(),
  to: CalendarDay.optional(),
  /**
   * Whether the plan wastes less (`GeneratePlanRequest.lessWaste`) from now on:
   * kept with the plan when the whole of it is made again. Left out: as the
   * plan has it; a part of the plan made again always has it as the plan does.
   */
  lessWaste: z.boolean().optional(),
  /** Whether the plan wastes nothing (`GeneratePlanRequest.noWaste`) from now on, as `lessWaste` is kept. */
  noWaste: z.boolean().optional(),
}).prefault({});
export type RegenerateRequest = z.infer<typeof RegenerateRequest>;

/**
 * What a re-roll of a plan, of a part of it or of one day would do to the plan
 * as it stands, asked with the request the re-roll would be asked with: the
 * plan read as the re-roll reads it when the request arrives. Nothing is
 * drawn, so whether the limits of the plan hold is known only from the
 * re-roll itself.
 */
export const RerollPreview = z.object({
  /**
   * The days that get other meals: a meal of them gives place, or a meal of
   * the day's that none of its meals holds is filled.
   */
  days: z.number().int().min(0),
  /** The meals on those days that give place to others. */
  replaced: z.number().int().min(0),
  /** What stays as it is, and why. */
  kept: z.object({
    /** The days of the plan that were not asked for. */
    outside: z.number().int().min(0),
    /** The days asked for that are before today: they stay unless `includePast` is set. */
    past: z.number().int().min(0),
    /** The days asked for that the user skips: they keep what they hold. */
    skipped: z.number().int().min(0),
    /** The meals on the days filled again that were eaten: they stay unless `replaceEaten` is set. */
    eaten: z.number().int().min(0),
    /** The user's own meals on those days: they stay unless `replaceCustom` is set. */
    custom: z.number().int().min(0),
    /** The leftovers on those days that are not eaten: food there is already, they always stay. */
    leftover: z.number().int().min(0),
    /** The meals on those days locked to the recipe they have, which they get again. */
    locked: z.number().int().min(0),
  }),
  /**
   * What the days asked for hold that the request could let go as well: days
   * before today (`includePast`), and on the days that would be filled again,
   * meals marked as eaten (`replaceEaten`) and the user's own (`replaceCustom`).
   */
  couldGo: z.object({ past: z.boolean(), eaten: z.boolean(), custom: z.boolean() }),
  /**
   * Why the days from today on (`from` the client's day) are no choice of
   * their own for this plan: it has not begun, so that is all of it
   * (`not_begun`), or it is over (`over`). Null where they are one.
   */
  fromToday: z.enum(['not_begun', 'over']).nullable(),
  /** The meals cooked with those that give place, on the days that are not filled again. */
  cooking: CookingChange,
});
export type RerollPreview = z.infer<typeof RerollPreview>;

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
  /** What the day comes to: its meals, and the entries of the profile's diary for its date. */
  dayNutrition: Nutrition,
  /** Fibre, sugars, salt and saturated fat of the same. */
  dayLabel: LabelTotals,
  /** The limits of the profile the day crosses; none for a skipped day. */
  labelNotes: z.array(LabelLimitNote).max(LabelNutrient.options.length),
  /**
   * What the profile's diary holds for the day besides its meals: how many
   * entries, what they come to, and the entries themselves, the first written
   * first, which a plan shows under the meals they were written for. They count
   * in `dayNutrition` and in where the day stands, as eaten, and a rebalance,
   * or filling the day again, leaves room for them. Null when the diary holds
   * none for the day.
   */
  diary: z
    .object({
      entries: z.number().int().min(1),
      nutrition: Nutrition,
      items: z.array(DiaryEntry).max(MAX_DIARY_ENTRIES_A_DAY),
    })
    .nullable(),
  calorieTarget: z.number(),
  /**
   * What the day aims at of protein, fat and carbohydrate, in grams: its
   * calorie target split as the plan's diet splits a day. A training or rest
   * day keeps the protein of a usual day of its week, and its carbohydrates
   * their share of its energy; fat takes what is left.
   */
  targetMacros: Macros,
  /** Signed delta vs. target — positive means over budget. Zero for a skipped day. */
  calorieDelta: z.number(),
  /**
   * Where the day stands outside the tenth either side of its target that a
   * plan is held to: `over` or `under`. Null inside it, and for a skipped
   * day. What a rebalance could not bring back says so here, for as long as
   * it is so.
   */
  offTarget: z.enum(['over', 'under']).nullable(),
  /**
   * What the day holds lies far from the split of protein, fat and carbohydrate
   * it aims at: over 12 % of its energy would have to move. False for a skipped day.
   */
  macrosOff: z.boolean(),
  /**
   * The user skips this day: it is no shortfall, and is left out of the
   * plan's averages. What was eaten of it before it was skipped stays on it.
   */
  skipped: z.boolean(),
  /** A target somebody typed, for the plan or for this day, has put the day under the lowest a calculated plan goes. */
  belowSafetyFloor: z.boolean(),
  /** Advanced per-day overrides, or null for a basic-flow day. */
  overrides: MealPlanDayOverrides.nullable(),
  /**
   * How many meals the day is set for: its own number, the plan's, or else as
   * many as it has from the catalogue. What a change of the day's settings
   * starts from (`DaySettings`).
   */
  mealCount: z.number().int().min(2).max(5),
  /**
   * A shopping list of the plan covers the day: once its meals or their
   * portions change, the list says it is out of date, which a change says
   * before it is made.
   */
  listed: z.boolean(),
});
export type MealPlanDay = z.infer<typeof MealPlanDay>;

/**
 * What a day of a running plan can be set to, from today on: what a day of a
 * new plan can be given (`DayOverride`), but its locks. A setting left as the
 * plan has it (a `normal` day, no target of its own, no limit on cooking, the
 * plan's number of meals) is kept as none.
 *
 * What a change does to the day's meals: another kind of day, or a target of
 * its own, keeps the dishes in other portions; another number of meals keeps
 * the dishes of the meals that stay, in other portions, draws recipes for the
 * meals the day gains and takes away those it loses; a limit on cooking time
 * draws other recipes for the meals over it, and `useUpBy` for every meal not
 * yet eaten. Eaten meals and the user's own stay as they are; a skipped day
 * keeps only what was eaten. `POST /meal-plans/:id/days/:dayId/settings/preview`
 * says which of this a change does before it is made.
 */
export const DaySettings = z.object({
  dayType: z.enum(['normal', 'rest', 'training']),
  skip: z.boolean(),
  mealCount: z.number().int().min(2).max(5),
  /** A target of the day's own; null for the one its kind gives. */
  calorieTarget: z.number().int().min(MIN_CALORIE_TARGET).max(MAX_CALORIE_TARGET).nullable(),
  /** The most minutes a recipe of the day may take to prepare and cook; null for no limit. */
  cookTimeBudgetMinutes: z.number().int().min(0).max(600).nullable(),
  /** Put first the recipes that use what the pantry has to use up by this day. */
  useUpBy: z.boolean(),
});
export type DaySettings = z.infer<typeof DaySettings>;

/**
 * Change the settings of a day (`DaySettings`) on the plan as it was when the
 * preview was asked for: a plan that changed since answers 409
 * `PLAN_CHANGED`, and a day before today 409 `DAY_IN_THE_PAST`. Recipes are
 * drawn inside the limits of the plan, as for a day made again, and
 * `allowRelaxations` is what it is there.
 */
export const ApplyDaySettingsRequest = DaySettings.extend({
  revision: z.number().int().min(0).max(2_147_483_647),
  allowRelaxations: z.array(PlanRelaxation).max(PLAN_RELAXATIONS.length).optional(),
  /** The recipe drawn for a meal goes on the meals cooked with it as well. */
  together: z.boolean().default(false),
  /**
   * The week of the day is evened out with the change: the days of it from
   * today on that share it get the targets that bring its average back to the
   * plan's target, and their dishes stay in other portions (`PlanWeek`).
   */
  evenWeek: z.boolean().default(false),
});
export type ApplyDaySettingsRequest = z.infer<typeof ApplyDaySettingsRequest>;

/** What a change of a day's settings does to one of its meals, and why. */
export const DayMealFate = z.object({
  mealId: z.string().uuid(),
  mealType: MealType,
  /** `stays` as it is; `resized`: the same dish in another amount; `redrawn`: another recipe is drawn for the meal; `removed`: it leaves the day. */
  fate: z.enum(['stays', 'resized', 'redrawn', 'removed']),
  /**
   * Why, where it is more than the day's new target or number of meals:
   * `eaten` and `own` meals and a `leftover` stay; `fewer_meals` and `skipped`
   * are what take a meal away; `over_cook_time` and `use_up` what draw another
   * recipe.
   */
  because: z
    .enum(['eaten', 'own', 'leftover', 'fewer_meals', 'skipped', 'over_cook_time', 'use_up'])
    .nullable(),
});
export type DayMealFate = z.infer<typeof DayMealFate>;

/** What a change of a day's settings would do, as `POST /meal-plans/:id/days/:dayId/settings/preview` answers it. Nothing is written. */
export const DaySettingsPreview = z.object({
  /** The plan's revision this is for: handed back with the change. */
  revision: z.number().int().min(0),
  date: z.string().date(),
  /** The day's target, and what it aims at of protein, fat and carbohydrate: now, and after the change. */
  calorieTarget: z.object({ now: z.number(), then: z.number() }),
  targetMacros: z.object({ now: Macros, then: Macros }),
  /** A target typed for the day would put it under the lowest a calculated plan goes. */
  belowSafetyFloor: z.boolean(),
  /** Each meal of the day, in the order they are eaten. */
  meals: z.array(DayMealFate),
  /** The meals the day would gain, in the order they are eaten: a recipe is drawn for each. */
  added: z.array(MealType),
  /**
   * What the day would hold where the change draws no recipe, its portions
   * worked out as the change would work them out. Null where recipes are
   * drawn: what they hold is known once they are.
   */
  dayCalories: z.number().nullable(),
  /** Whether that is inside the tenth either side of the new target that a plan is held to. Null with `dayCalories`. */
  fits: z.boolean().nullable(),
  /** A shopping list of the plan covers the day: once its meals change, it says that it is out of date. */
  listOutOfDate: z.boolean(),
  /** The change does nothing to the day. */
  unchanged: z.boolean(),
  /** The meals cooked with those that get another recipe. */
  cooking: CookingChange,
  /**
   * The week of the plan the day is in (`PlanWeek`): what the days that share
   * it aim at on average now, with the change of this day alone, and with the
   * change and the week evened out (`evenWeek`), against the plan's target;
   * the pace each average comes to against the profile's maintenance, in
   * kilograms a week (less than nothing for a gain); the target this day gets
   * in an evened week, and how many other days evening it out changes. Null
   * where no day of the week shares it.
   */
  week: z
    .object({
      target: z.number(),
      average: z.object({ now: z.number(), alone: z.number(), evened: z.number() }),
      pace: z.object({ now: z.number(), alone: z.number(), evened: z.number() }),
      /** With the change alone, the average lies off the target and evening the week out would bring it nearer. */
      unevenAlone: z.boolean(),
      evenedTarget: z.number(),
      otherDays: z.number().int().min(0),
      /** A shopping list of the plan covers one of the other days evening the week out changes. */
      listOutOfDate: z.boolean(),
    })
    .nullable(),
});
export type DaySettingsPreview = z.infer<typeof DaySettingsPreview>;

/**
 * Even out the week of a plan the day `date` is in, on the plan as it was at
 * `revision`: the days of the week from today on that share it, and have a
 * meal left to eat, get the targets that bring its average back to the plan's
 * target (`PlanWeek`), in the same proportions of their kinds, and their
 * dishes stay in other portions. A plan that changed since answers 409
 * `PLAN_CHANGED`; a week no day of which can change is left as it is.
 */
export const EvenWeekRequest = z.object({
  date: CalendarDay,
  revision: z.number().int().min(0).max(2_147_483_647),
});
export type EvenWeekRequest = z.infer<typeof EvenWeekRequest>;

/**
 * Take the profile's target from today (`POST /meal-plans/:id/retarget`): the
 * plan's target becomes the profile's, its days from today get their targets
 * from it, kinds of day and their own targets kept, the same dishes in other
 * portions; days before today stay as they were. A plan that changed since
 * answers 409 `PLAN_CHANGED`.
 */
export const RetargetPlanRequest = z.object({
  revision: z.number().int().min(0).max(2_147_483_647),
});
export type RetargetPlanRequest = z.infer<typeof RetargetPlanRequest>;

/** A pack that a plan's menu opens and does not finish. */
export const PlanOpenPack = z.object({
  ingredientId: z.string().uuid(),
  name: z.string(),
  /** What the pack, and what is left of it, are counted in: grams or millilitres. */
  unit: Unit,
  packSize: z.number().positive(),
  /** How many packs the menu takes of the ingredient. */
  packs: z.number().int().min(1),
  /** What the menu leaves of the last of them, to the gram or millilitre. */
  left: z.number().int().min(1),
  /** More of it is left than the fifth of a pack that a plan accepts. */
  wasted: z.boolean(),
});
export type PlanOpenPack = z.infer<typeof PlanOpenPack>;

/**
 * What a plan's menu comes to in packs that do not keep once they are opened:
 * the whole packs it takes (`bought`) against what it uses of them (`used`),
 * grams and millilitres added up as they are, and the packs it does not
 * finish, the one with the most left first. An ingredient that is bought
 * loose, or whose opened pack keeps, is not counted. What is at home already
 * is not either: this is the menu, and the shopping list is what knows the
 * kitchen.
 */
export const PlanPacks = z.object({
  bought: z.number().min(0),
  used: z.number().min(0),
  open: z.array(PlanOpenPack),
});
export type PlanPacks = z.infer<typeof PlanPacks>;

/**
 * A week of a plan: seven of its days from its first, the last week as long
 * as what is left. The kinds of day move calories between the days of a week:
 * a training day about 15 % over a usual day of it, a rest day about 15 %
 * under, and the days that share the week (not skipped, and with no target of
 * their own) aim at the plan's target on average. A change of one day of a
 * running plan can leave the average off it, until the week is evened out.
 */
export const PlanWeek = z.object({
  from: z.string().date(),
  to: z.string().date(),
  /** The plan's own calorie target. */
  target: z.number(),
  /** What the days that share the week aim at on average; null where none does. */
  average: z.number().nullable(),
  /**
   * The average lies off the target by more than a hundredth of it, and days
   * of the week from today on can still bring it back (`EvenWeekRequest`).
   */
  uneven: z.boolean(),
  /** A shopping list of the plan covers a day of the week that evening it out can change. */
  listOutOfDate: z.boolean(),
});
export type PlanWeek = z.infer<typeof PlanWeek>;

/** A full multi-day meal plan. */
export const MealPlan = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  startDate: z.string().date(),
  durationDays: z.number().int(),
  dietType: DietType,
  days: z.array(MealPlanDay),
  /** Its weeks, the first first. */
  weeks: z.array(PlanWeek),
  /**
   * The profile's target now and the one the plan was made with, where they
   * part by `TARGET_MOVED_LEAST_KCAL` or more and the plan has days to come;
   * null otherwise, and for a plan whose target was typed for it.
   */
  targetMoved: z
    .object({ profileTarget: z.number().int(), planTarget: z.number().int() })
    .nullable(),
  /** Averages of the plan's meals over the days that are not skipped, without the diary's entries, and the optimiser's reuse score (0-1). */
  averageDailyNutrition: Nutrition,
  /** What a day at the plan's own calorie target aims at of protein, fat and carbohydrate, in grams. */
  targetMacros: Macros,
  /** Where those averages stand against what the days of the plan aim at, as a day's `offTarget` and `macrosOff` do. */
  averageOff: z.object({ calories: z.enum(['over', 'under']).nullable(), macros: z.boolean() }),
  ingredientReuseScore: z.number().min(0).max(1),
  /** What the menu, as it is now, buys and uses of packs that do not keep. */
  packs: PlanPacks,
  /** `ai_assisted` where a meal of the plan holds a model's pick now; `deterministic` otherwise. */
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
  /**
   * The plan of the other profile this one was made together with: their
   * meals at the times of day both have are shared (`PlannedMeal.shared`).
   * Null for a plan of one person, and once the other plan is deleted.
   */
  joint: z
    .object({ planId: z.string().uuid(), profileId: z.string().uuid(), profileName: z.string() })
    .nullable(),
});
export type MealPlan = z.infer<typeof MealPlan>;

/** Where a plan stands on a day: under way, over, or still to begin. */
export const PlanStatus = z.enum(['active', 'past', 'upcoming']);
export type PlanStatus = z.infer<typeof PlanStatus>;

/** A number of things out of how many there are. */
const Share = z.object({ meals: z.number().int().min(0), of: z.number().int().min(0) });

/**
 * What a profile's plan of the moment comes to, for somebody who opens the
 * application to see how they stand. The plan of the moment is the one under
 * way; with none under way, the one that begins next; with none ahead, the
 * one that ended last.
 */
export const PlanOverview = z.object({
  plan: z.object({
    id: z.string().uuid(),
    startDate: z.string().date(),
    durationDays: z.number().int().min(1),
    dietType: DietType,
    status: z.enum(['active', 'upcoming', 'past']),
  }),
  /** Kilocalories a day, on average over the days that are not skipped: what the plan holds and what it aims at. */
  energy: z.object({ planned: z.number().min(0), target: z.number().min(0) }),
  /** Grams a day, on the same average. */
  macros: z.object({ planned: Macros, target: Macros }),
  /** Of the meals of the days that have come, today included, how many are marked as eaten. */
  eaten: Share,
  /** Of the meals that have a recipe, how many fit the diet of the plan. */
  onDiet: Share,
  /** Of the same meals, how many are of a recipe the profile marked as a favourite or as eaten often. */
  favourites: Share,
  /** 0-1: the share of the plan's ingredients that more than one of its recipes uses. */
  ingredientReuse: z.number().min(0).max(1),
  /** The plan's shopping lists: how many there are, and how many of their entries are ticked. */
  shopping: z.object({
    lists: z.number().int().min(0),
    entries: z.number().int().min(0),
    ticked: z.number().int().min(0),
  }),
  /** Day by day: what the day holds and what it aims at, in kilocalories. */
  days: z.array(
    z.object({
      date: z.string().date(),
      calories: z.number().min(0),
      target: z.number().min(0),
      skipped: z.boolean(),
    }),
  ),
});
export type PlanOverview = z.infer<typeof PlanOverview>;

/** Whose plan of the moment is asked about. */
export const PlanOverviewQuery = z.object({ profileId: z.string().uuid() });
export type PlanOverviewQuery = z.infer<typeof PlanOverviewQuery>;

/** The overview, or none for a profile that has no plan. */
export const PlanOverviewAnswer = z.object({ overview: PlanOverview.nullable() });
export type PlanOverviewAnswer = z.infer<typeof PlanOverviewAnswer>;

/** The most days a calendar of plans is asked for at once: the six weeks a month is drawn in. */
export const MAX_CALENDAR_DAYS = 42;

/** The days from one calendar day to another, both counted. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Whose plans are asked about, and on which days: from one calendar day to another, both included. */
export const PlanCalendarQuery = z
  .object({ profileId: z.string().uuid(), from: CalendarDay, to: CalendarDay })
  .refine((asked) => asked.from <= asked.to, {
    path: ['to'],
    message: 'The last day cannot be before the first.',
  })
  .refine(
    (asked) => asked.from > asked.to || daysBetween(asked.from, asked.to) <= MAX_CALENDAR_DAYS,
    { path: ['to'], message: `At most ${MAX_CALENDAR_DAYS} days at once.` },
  );
export type PlanCalendarQuery = z.infer<typeof PlanCalendarQuery>;

/** A day that a plan of the profile holds, as a calendar shows it. */
export const PlanCalendarDay = z.object({
  date: z.string().date(),
  /** The plan that holds the day: the one made last, when several do. */
  planId: z.string().uuid(),
  /** How many plans of the profile hold the day. */
  plans: z.number().int().min(1),
  /** What the day holds and what it aims at, in kilocalories. */
  calories: z.number().min(0),
  target: z.number().min(0),
  /** `MealPlanDay.offTarget` of the same day. */
  offTarget: z.enum(['over', 'under']).nullable(),
  /** Of the meals of the day, how many are marked as eaten. */
  eaten: Share,
  skipped: z.boolean(),
});
export type PlanCalendarDay = z.infer<typeof PlanCalendarDay>;

/** The days of the span that a plan holds, in order. A day no plan holds is not among them. */
export const PlanCalendar = z.object({ days: z.array(PlanCalendarDay) });
export type PlanCalendar = z.infer<typeof PlanCalendar>;

/**
 * A plan as a list shows it: what it is and what a day of it holds on
 * average, without its days and what is counted from their meals.
 * `GET /meal-plans/:id` answers the whole plan.
 */
export const MealPlanSummary = MealPlan.omit({
  averageOff: true,
  days: true,
  weeks: true,
  targetMoved: true,
  report: true,
  targetMacros: true,
  packs: true,
});
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
export const SwapMealRequest = z
  .object({
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
    /**
     * Of a shared meal (`PlannedMeal.shared`): the dish for both people, each
     * sized to their own portion. Only a dish the other person may be given
     * too, and their day does not hold already, is offered or taken.
     */
    forAll: z.boolean().default(false),
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
  /** Put before the model first what the pantry covers. */
  respectInventory: z.boolean().default(true),
  /** Recipes offered for this meal already in this sitting. */
  skip: z.array(z.string().uuid()).max(100).default([]),
  /**
   * Of a shared meal (`PlannedMeal.shared`): the dish for both people, each
   * sized to their own portion. Only a dish the other person may be given
   * too, and their day does not hold already, is offered or taken.
   */
  forAll: z.boolean().default(false),
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
  targetMacros: Macros,
  /** What it would do to the other meals of the same cooking. */
  cooking: CookingChange,
  /** The limits of the plan the recipe is outside of on this meal: only where no other is left, or it was picked by hand. */
  outsideLimits: z.array(PlanRelaxation),
  /** The revision of the plan the offer was made from: sent back to make the swap. */
  revision: z.number().int().min(0),
});
export type MealSwapPreview = z.infer<typeof MealSwapPreview>;

/**
 * An offer a model was asked for: `aiMeta` says who picked, or why the engine
 * did. `pick` is the note of a model's pick, to hand back when the offer is
 * taken; null when the engine picked.
 */
export const AiMealSwapPreview = MealSwapPreview.extend({
  aiMeta: AiGenerationMeta,
  pick: ModelPickNote.nullable(),
  /**
   * Of a meal both people of a joint plan eat, where this person's day would
   * stay off its split: the topping the model named for their plate, among
   * those that go with the dish and fit them, named in the reader's language.
   * Taken with the offer, it is put on the plate in the amount the day needs.
   * Null where none was named.
   */
  topping: z.object({ key: z.string(), name: z.string() }).nullable(),
});
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
  /** The recipe goes on the other meals of the same cooking as well, as the offer said. */
  together: z.boolean().default(false),
  /** Of a shared meal: the dish goes on the other person's meal too, as the offer was asked (`SwapMealRequest.forAll`). */
  forAll: z.boolean().default(false),
});
export type ApplyMealSwapRequest = z.infer<typeof ApplyMealSwapRequest>;

/**
 * Take back the last swap of a meal or of an ingredient: the dishes and the
 * portions of the days it changed. `revision` is the plan's as that swap left
 * it: 409 `PLAN_CHANGED` for a plan that changed since, 409 `NOTHING_TO_UNDO`
 * for one no swap of which can be taken back.
 */
export const UndoSwapRequest = z.object({
  planId: z.string().uuid(),
  revision: z.number().int().min(0).max(2_147_483_647),
});
export type UndoSwapRequest = z.infer<typeof UndoSwapRequest>;

/**
 * Whether a model is asked to weigh what the engine proposes: to put the
 * proposals in order and say a sentence of each. One call on the caller's AI
 * allowance. The engine makes the proposals either way, and they are the same
 * ones: a model adds nothing to them and takes none away.
 */
export const WeighRequest = z.object({ weigh: z.boolean().default(false) });
export type WeighRequest = z.infer<typeof WeighRequest>;

/**
 * What a menu buys in packs that do not keep against what it uses of them,
 * and how many of those packs it leaves more than a fifth of (see
 * `PlanPacks`).
 */
export const PackTally = z.object({
  bought: z.number().min(0),
  used: z.number().min(0),
  wasted: z.number().int().min(0),
});
export type PackTally = z.infer<typeof PackTally>;

/**
 * The note of an offer to fill a day another way. The API signs it and hands
 * it out with the offer, before anything is written; the request that takes
 * the offer hands it back. It is good for the day of the plan as the plan
 * stood. Opaque: a client passes it on unread.
 */
export const DayOfferNote = z.string().min(1).max(2048);
export type DayOfferNote = z.infer<typeof DayOfferNote>;

/** A meal of a day as another way to fill the day has it. */
export const DayVariationMeal = z.object({
  mealType: MealType,
  /** The name of its recipe, or of a meal of the user's own. */
  title: z.string(),
  /** Null for a meal of the user's own. */
  recipeId: z.string().uuid().nullable(),
  servings: z.number(),
  nutrition: Nutrition,
  /** The meal is on the day already and stays there: it was eaten, it is the user's own, or a leftover. */
  stays: z.boolean(),
});
export type DayVariationMeal = z.infer<typeof DayVariationMeal>;

/** Another way to fill a day of a plan. */
export const DayVariation = z.object({
  /** The meals of the day in the order they are eaten, those that stay among them. */
  meals: z.array(DayVariationMeal),
  dayNutrition: Nutrition,
  /** What the menu of the whole plan would come to in packs with the day filled this way. */
  packs: PackTally,
  /** A model's sentence on this way: what speaks for it and what against. Null when no model was asked, or it said none. */
  reason: z.string().max(200).nullable(),
  /** Handed back to take this way (`TakeDayVariationRequest`). */
  offer: DayOfferNote,
});
export type DayVariation = z.infer<typeof DayVariation>;

/**
 * Other ways to fill a day, as `POST /meal-plans/:id/days/:dayId/variations`
 * answers them. The engine makes each of them as it makes a day again: inside
 * the limits of the plan, around the meals that stay, with everything the
 * profile rules out left out. Nothing is written.
 */
export const DayVariations = z.object({
  date: z.string().date(),
  calorieTarget: z.number(),
  /**
   * What the profile's diary holds for the day, which is eaten: every way
   * fills what is left of the target, and every `dayNutrition` here counts it.
   * Null when it holds nothing.
   */
  diary: Nutrition.nullable(),
  /** The day as it is, to hold the others against. */
  current: z.object({ dayNutrition: Nutrition, packs: PackTally }),
  /** The meals cooked with those of the day that give place, on other days. */
  cooking: CookingChange,
  /**
   * Up to three ways that differ from the day as it is and from each other:
   * in the order a model gave them where one was asked and answered, in the
   * engine's otherwise. None where the catalogue leaves no other way.
   */
  variations: z.array(DayVariation).max(3),
  /** Who put them in order, or why the engine's order stands. Null when no model was asked. */
  aiMeta: AiGenerationMeta.nullable(),
});
export type DayVariations = z.infer<typeof DayVariations>;

/**
 * Take one of the ways a day was offered. The day gets its meals as the offer
 * had them; each recipe is judged again before it is written. A plan that
 * changed since the offer answers 409 `PLAN_CHANGED`, and a note that is not
 * for this day of this plan, or has run out, 400 `OFFER_INVALID`. The way a
 * model put first is written as its pick: the meals say so, and the plan says
 * that a model had a part in it.
 */
export const TakeDayVariationRequest = z.object({
  offer: DayOfferNote,
  /** The dish a meal gets goes on the meals cooked with it on other days. */
  together: z.boolean().default(false),
});
export type TakeDayVariationRequest = z.infer<typeof TakeDayVariationRequest>;

/** A recipe in the place of a meal that would use up what the plan opens. */
export const UseUpSuggestion = z.object({
  plannedMealId: z.string().uuid(),
  date: z.string().date(),
  mealType: MealType,
  /** The recipe the meal holds, and the one that would take its place. */
  from: z.object({ id: z.string().uuid(), title: z.string() }),
  to: z.object({ id: z.string().uuid(), title: z.string() }),
  /** How many servings of it the meal would be: as many as come nearest to what the meal holds now. */
  servings: z.number(),
  /** What the meal holds now, and what it would hold. */
  before: Nutrition,
  after: Nutrition,
  /**
   * The packs the menu leaves more than a fifth of that the recipe takes
   * from: how much more of each the menu would use, and what would then be
   * left of its last pack, to the gram or millilitre.
   */
  takes: z
    .array(
      z.object({
        ingredientId: z.string().uuid(),
        name: z.string(),
        unit: Unit,
        amount: z.number().int().min(1),
        left: z.number().int().min(0),
      }),
    )
    .min(1),
  /** What the menu comes to in packs now, and what it would come to. */
  packs: z.object({ before: PackTally, after: PackTally }),
  /** A model's sentence on the swap. Null when no model was asked, or it said none. */
  reason: z.string().max(200).nullable(),
  /**
   * The note of a model's pick, for the swap a model put first: handed back
   * as `pick` of `ApplyMealSwapRequest`, and the meal then says that a model
   * chose its recipe. Null on every other.
   */
  pick: ModelPickNote.nullable(),
});
export type UseUpSuggestion = z.infer<typeof UseUpSuggestion>;

/**
 * Swaps that would use up what a plan opens, as `POST /meal-plans/:id/use-up`
 * answers them: for the meals from today on that are not eaten, the recipes
 * that may take their place (as a swap offers them) and leave less of the
 * packs that do not keep, one for a meal, the one that leaves the least
 * first. A suggestion is taken with `ApplyMealSwapRequest` (`recipeId` its
 * `to`, `strategy` `random`, `revision` the one here). Nothing is written.
 */
export const UseUpSuggestions = z.object({
  revision: z.number().int().min(0),
  suggestions: z.array(UseUpSuggestion).max(5),
  /** Who put them in order, or why the engine's order stands. Null when no model was asked. */
  aiMeta: AiGenerationMeta.nullable(),
});
export type UseUpSuggestions = z.infer<typeof UseUpSuggestions>;

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
   * the text, as it does in every other language either way. No model is
   * asked where the substitution gives a recipe the shared library or the
   * caller has already: that recipe keeps its text, and the answer carries no
   * AI metadata.
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
  /** The other meals of the same cooking get the recipe it leaves as well. */
  together: z.boolean().default(false),
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
  macroDelta: MacroChange,
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
  /** The limits of the plan the recipe it would leave is outside of on this meal: no bar to it, and said. */
  outsideLimits: z.array(PlanRelaxation),
  /** What it would do to the other meals of the same cooking. */
  cooking: CookingChange,
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
  name: z.string().trim().min(1).max(OWN_MEAL_LIMITS.name),
  mealType: MealType,
  /**
   * User-entered figures of one serving: its energy, and of the macronutrients
   * those that are known. Engine never recomputes what is given; those left out
   * are estimated from what is left of the energy, in the proportions of the
   * day's target, and the meal says that they were. 400
   * `DIARY_MACROS_OVER_ENERGY` where the ones given hold more than the energy.
   */
  nutrition: EnteredNutrition.partial({ protein: true, fat: true, carbs: true }),
  servings: z
    .number()
    .min(OWN_MEAL_LIMITS.servings.min)
    .max(OWN_MEAL_LIMITS.servings.max)
    .default(1),
  /**
   * A meal of the same day that this one is eaten in the place of: it leaves
   * the day. Left out, this one comes beside the meals the day has. 404
   * `MEAL_NOT_FOUND` for a meal that is not on that day.
   */
  replaces: z.string().uuid().optional(),
});
export type AddCustomMealRequest = z.infer<typeof AddCustomMealRequest>;

/**
 * Explicit rebalance trigger. `day` rebalances the single date. `plan` takes
 * the days from `date` (today when it is left out) to the end of the plan:
 * each day that is outside its window is brought back with its own meals, and
 * what it cannot absorb is spread over the others inside their own windows.
 * The meals of a day before today are done with, so such a day is made up for
 * by the days from today on alone. Days before `date` and skipped days are
 * not touched. `restore` is the undo path:
 * when present the service writes those exact scales verbatim and skips the
 * solver (the toast's "Undo last rebalance" sends the pre-edit `before` map).
 */
export const RebalanceRequest = z
  .object({
    scope: z.enum(['day', 'plan']),
    /** Required for `day`. For `plan` the first day that counts; today when left out. */
    date: CalendarDay.optional(),
    restore: z
      .array(z.object({ mealId: z.string().uuid(), scale: z.number().min(0).max(10) }))
      .max(MAX_PLAN_MEALS)
      .optional(),
  })
  // One day is rebalanced by its date; an undo names its meals instead.
  .refine(
    (request) =>
      request.scope !== 'day' || request.date !== undefined || (request.restore?.length ?? 0) > 0,
    {
      path: ['date'],
      message: 'Name the day to rebalance.',
    },
  )
  .refine(
    (request) =>
      new Set(request.restore?.map((entry) => entry.mealId)).size ===
      (request.restore?.length ?? 0),
    {
      path: ['restore'],
      message: 'A meal is put back once.',
    },
  );
export type RebalanceRequest = z.infer<typeof RebalanceRequest>;

/** A single meal's quantity-scale change produced by a rebalance. */
export const RebalanceChange = z.object({
  mealId: z.string().uuid(),
  before: z.number(),
  after: z.number(),
});
export type RebalanceChange = z.infer<typeof RebalanceChange>;

/** Mark a planned meal eaten (`true`) or not eaten (`false`). Repeating a request changes nothing. */
export const SetMealEatenRequest = z.object({
  eaten: z.boolean(),
  /**
   * Of a shared meal (`PlannedMeal.shared`): the other person's meal is marked
   * as well, "we ate", and their day rebalanced as this one is. Each may also
   * mark only their own, as without it.
   */
  forAll: z.boolean().default(false),
});
export type SetMealEatenRequest = z.infer<typeof SetMealEatenRequest>;

/**
 * Taking a meal off its day: `forAll`, of a shared meal, takes the other
 * person's meal off their day as well, where they have not eaten it.
 */
export const RemoveMealQuery = z.object({
  forAll: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type RemoveMealQuery = z.infer<typeof RemoveMealQuery>;

/** How a shared meal is cooked: `apart`, each portion on its own, or in one pot split by weight. */
export const SetSharedMealRequest = z.object({ apart: z.boolean() });
export type SetSharedMealRequest = z.infer<typeof SetSharedMealRequest>;

/** A portion of a meal: its servings as eaten (servings times the rebalancer's multiplier) and its kcal. */
const Portion = z.object({ servings: z.number(), calories: z.number() });

/** A meal of the next day that a leftover may take the place of. */
const LeftoverPlace = z.object({
  mealType: MealType,
  /** What the meal holds now: the dish, or the name of a meal of one's own. */
  name: z.string(),
  calories: z.number(),
  /** The other person of a joint plan shares it: given a leftover for one, it stays theirs alone. Null otherwise. */
  sharedWith: z.string().nullable(),
  /** The meal's cooking ahead, as the plan says it (`PlannedMeal.cookAhead`): what follows for its other meals when it leaves it. */
  cookAhead: z.enum(['cook', 'cooked']).nullable(),
  /** The other meals of that cooking. Empty where `cookAhead` is null. */
  cookedWith: z.array(OtherMealOfCooking),
});

/**
 * Where what is left of a meal can go, as `GET /meal-plans/:id/meals/:mealId/leftover`
 * answers: the next day, in the plan of the person made last that holds it, and
 * the meals of it a leftover may take the place of. Nothing is written.
 */
export const LeftoverOffer = z.object({
  planId: z.string().uuid(),
  date: z.string().date(),
  /** The whole portion of the meal it is left of. */
  portion: Portion,
  places: z.array(LeftoverPlace),
  /**
   * Of a shared meal, the other person's side, for a leftover for both: their
   * portion, whether they marked it eaten, and the times of day of their next
   * day a leftover may take. Null for a meal of one plan, and where their next
   * day is in no plan or is skipped.
   */
  other: z
    .object({
      profileName: z.string(),
      eaten: z.boolean(),
      portion: Portion,
      places: z.array(MealType),
    })
    .nullable(),
});
export type LeftoverOffer = z.infer<typeof LeftoverOffer>;

/**
 * Put what is left of a meal in as a meal of the next day, in the place of the
 * dish at `mealType`. `left` is the part of the portion left: 1 where nothing
 * was eaten, and the meal then leaves its day; less, and the meal stays marked
 * eaten with the part eaten. `forAll`, of a shared meal, does the same with the
 * other person's portion, of which `theirLeft` is left, and the two leftovers
 * are shared as well.
 */
export const PutLeftoverRequest = z
  .object({
    mealType: MealType,
    left: z.number().gt(0).max(1),
    forAll: z.boolean().default(false),
    theirLeft: z.number().gt(0).max(1).optional(),
  })
  .refine((request) => !request.forAll || request.theirLeft !== undefined, {
    message: 'A leftover for both says what the other person has left.',
    path: ['theirLeft'],
  });
export type PutLeftoverRequest = z.infer<typeof PutLeftoverRequest>;

/**
 * Undoing a leftover: `forAll`, of a leftover made for both, undoes the other
 * person's as well, where they have not eaten it.
 */
export const UndoLeftoverQuery = z.object({
  forAll: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type UndoLeftoverQuery = z.infer<typeof UndoLeftoverQuery>;

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
      scope: z.enum(['day', 'plan']),
      feasibility: z.enum(['in-window', 'best-effort']),
      changes: z.array(RebalanceChange),
      /** For `plan`: the kcal the days still are off by together after the rebalance; zero when the other days took it all, and for `day`. */
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
export const SwapIngredientResponse = RebalanceResult.extend({
  aiMeta: AiGenerationMeta.nullable(),
});
export type SwapIngredientResponse = z.infer<typeof SwapIngredientResponse>;
