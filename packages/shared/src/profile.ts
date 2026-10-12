// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { ActivityLevel, Allergen, DietType, MealType, Sex, WeeklyLossTarget } from './enums.js';
import { MAX_INGREDIENT_IDS } from './ingredient.js';
import { MacroSplit, MAX_CALORIE_TARGET, MIN_CALORIE_TARGET } from './nutrition.js';
import { WeightReminderCadence } from './weight.js';

/**
 * How many profiles an account may hold is for whoever runs an instance to
 * say: this many unless they say otherwise, and never more than the most.
 * A client reads the number of its instance from the public configuration.
 */
export const DEFAULT_PROFILES_PER_ACCOUNT = 2;
export const MOST_PROFILES_PER_ACCOUNT = 20;

/** The most of one ingredient a plan may hold in seven days: what a profile starts with, and what it may be set to. */
export const DEFAULT_WEEKLY_AMOUNT_PER_INGREDIENT = 3000;
export const MIN_WEEKLY_AMOUNT_PER_INGREDIENT = 500;
export const MAX_WEEKLY_AMOUNT_PER_INGREDIENT = 10_000;

/** What a profile's preferences hold, each part as it is checked. */
const preferenceFields = {
  /** Ingredients the planner should prefer (a scoring bias, not a hard rule). */
  favoriteIngredientIds: z.array(z.string().uuid()).max(MAX_INGREDIENT_IDS),
  /** Ingredients the planner must skip. */
  excludedIngredientIds: z.array(z.string().uuid()).max(MAX_INGREDIENT_IDS),
  allergens: z.array(Allergen).max(Allergen.options.length),
  dislikedFoods: z.array(z.string().trim().min(1).max(80)).max(50),
  preferredCuisines: z.array(z.string().trim().min(1).max(80)).max(50),
  /**
   * Hard cap on how many days in a row the same recipe may occupy a slot.
   * The scorer treats this as an exclusion (not a soft penalty) so even a
   * runaway "best-scoring" recipe is forced to step aside. 1 = no repeats
   * on adjacent days; higher = more meal-prep friendly. The plan generator
   * uses a permissive default when `mealPrepFriendly` is set on the
   * generation request.
   */
  maxConsecutiveDaysSameMeal: z.number().int().min(1).max(7),
  /**
   * Hard cap on how many times the same recipe may appear within any rolling
   * 7-day window. Stops a single high-scoring recipe from dominating a long
   * plan (28 days = the same meal every day was the reported failure mode).
   */
  maxTimesPerWeekSameMeal: z.number().int().min(1).max(7),
  /**
   * The most of one ingredient, in grams or millilitres, that the meals of
   * any seven days of a plan may hold together. It keeps a plan from resting
   * on one food, however the recipes that use it are spread.
   */
  maxWeeklyAmountPerIngredient: z.number().int().min(MIN_WEEKLY_AMOUNT_PER_INGREDIENT).max(MAX_WEEKLY_AMOUNT_PER_INGREDIENT),
  /**
   * Anti-monotony rotation threshold. After this many consecutive
   * plan-level generations actually applied the inventory bias, the next
   * round drops the pantry preference and the counter resets — keeps a
   * leftover-heavy month from locking the user into one recipe corridor.
   * `0` disables the rotation entirely (bias every round, no cap).
   */
  inventoryBiasResetEvery: z.number().int().min(0).max(20),
};

/** What a new profile prefers until it says otherwise. */
const PREFERENCE_DEFAULTS = {
  favoriteIngredientIds: [],
  excludedIngredientIds: [],
  allergens: [],
  dislikedFoods: [],
  preferredCuisines: [],
  maxConsecutiveDaysSameMeal: 2,
  maxTimesPerWeekSameMeal: 3,
  maxWeeklyAmountPerIngredient: DEFAULT_WEEKLY_AMOUNT_PER_INGREDIENT,
  inventoryBiasResetEvery: 5,
} satisfies { [Key in keyof typeof preferenceFields]: z.infer<(typeof preferenceFields)[Key]> };

/** Free-form preference bundle attached to a profile. A part that a new profile leaves out starts at its default. */
export const ProfilePreferences = z.object({
  favoriteIngredientIds: preferenceFields.favoriteIngredientIds.default(PREFERENCE_DEFAULTS.favoriteIngredientIds),
  excludedIngredientIds: preferenceFields.excludedIngredientIds.default(PREFERENCE_DEFAULTS.excludedIngredientIds),
  allergens: preferenceFields.allergens.default(PREFERENCE_DEFAULTS.allergens),
  dislikedFoods: preferenceFields.dislikedFoods.default(PREFERENCE_DEFAULTS.dislikedFoods),
  preferredCuisines: preferenceFields.preferredCuisines.default(PREFERENCE_DEFAULTS.preferredCuisines),
  maxConsecutiveDaysSameMeal: preferenceFields.maxConsecutiveDaysSameMeal.default(PREFERENCE_DEFAULTS.maxConsecutiveDaysSameMeal),
  maxTimesPerWeekSameMeal: preferenceFields.maxTimesPerWeekSameMeal.default(PREFERENCE_DEFAULTS.maxTimesPerWeekSameMeal),
  maxWeeklyAmountPerIngredient: preferenceFields.maxWeeklyAmountPerIngredient.default(PREFERENCE_DEFAULTS.maxWeeklyAmountPerIngredient),
  inventoryBiasResetEvery: preferenceFields.inventoryBiasResetEvery.default(PREFERENCE_DEFAULTS.inventoryBiasResetEvery),
});
export type ProfilePreferences = z.infer<typeof ProfilePreferences>;

/**
 * A change of some of a profile's preferences (`PATCH /profiles/:id/preferences`):
 * what is sent replaces what was there, and what is left out stays as it is.
 */
export const ProfilePreferencesPatch = z
  .object(preferenceFields)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Name at least one preference to change.' });
export type ProfilePreferencesPatch = z.infer<typeof ProfilePreferencesPatch>;

/** What a profile says of a person, each part as it is checked. */
const profileFields = {
  name: z.string().min(1).max(80),
  age: z.number().int().min(13).max(120),
  sex: Sex.nullable(),
  heightCm: z.number().min(100).max(250),
  weightKg: z.number().min(30).max(400),
  activityLevel: ActivityLevel,
  dietType: DietType,
  weeklyLossTarget: WeeklyLossTarget.nullable(),
  /** Manual kcal target; when set it overrides the calculated value. */
  manualCalorieTarget: z.number().int().min(MIN_CALORIE_TARGET).max(MAX_CALORIE_TARGET).nullable(),
  /** Default meal count (2-5) for new plans. */
  mealCount: z.number().int().min(2).max(5),
  /** How often the background worker should nudge to log a weight. */
  weightReminderCadence: WeightReminderCadence,
  /**
   * The split of a day's energy the profile aims at on the `custom` diet.
   * A profile on that diet has one; a profile on another may keep one for
   * when it goes back, or for a plan that is made for the custom diet.
   */
  customMacroSplit: MacroSplit.nullable(),
};

/** A profile on the custom diet says which split it aims at: no other diet's stands in for it. */
const hasItsSplit = (profile: { dietType: DietType; customMacroSplit: MacroSplit | null }): boolean => profile.dietType !== 'custom' || profile.customMacroSplit !== null;
const SPLIT_MISSING = { path: ['customMacroSplit'], message: 'The custom diet needs its split of protein, fat and carbohydrate.' };

/**
 * Sent as true by somebody under 18 or underweight who asks to lose weight
 * and has read the warning. Without it the goal is stored but planned as
 * maintenance (`CalorieCalculation.goalHeld`). Nothing for anybody else.
 */
const acknowledgeRisk = z.boolean().optional();

/** What a new profile holds. What a request leaves out starts at a default. */
const newProfile = z.object({
  name: profileFields.name,
  age: profileFields.age,
  sex: profileFields.sex.default(null),
  heightCm: profileFields.heightCm,
  weightKg: profileFields.weightKg,
  activityLevel: profileFields.activityLevel.default('moderate'),
  dietType: profileFields.dietType.default('balanced'),
  weeklyLossTarget: profileFields.weeklyLossTarget.default('0.5'),
  manualCalorieTarget: profileFields.manualCalorieTarget.default(null),
  acknowledgeRisk,
  mealCount: profileFields.mealCount.default(3),
  weightReminderCadence: profileFields.weightReminderCadence.default('weekly'),
  customMacroSplit: profileFields.customMacroSplit.default(null),
  preferences: ProfilePreferences.default(PREFERENCE_DEFAULTS),
});

/** A new profile. */
export const ProfileInput = newProfile.refine(hasItsSplit, SPLIT_MISSING);
export type ProfileInput = z.infer<typeof ProfileInput>;

/**
 * A profile as it is from now on (`PUT /profiles/:id`): every part of it,
 * its preferences too. A part that is left out is refused, not put back to a
 * default: a client that forgot one would otherwise change what it never
 * showed. To change some preferences alone there is `ProfilePreferencesPatch`.
 */
export const ProfileUpdate = z
  .object({
    ...profileFields,
    acknowledgeRisk,
    preferences: z.object(preferenceFields),
  })
  .refine(hasItsSplit, SPLIT_MISSING);
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

/** Persisted profile as returned by the API. */
export const Profile = newProfile.omit({ acknowledgeRisk: true }).extend({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  /** When the risk of losing weight was acknowledged, for a profile that needs it. */
  riskAcknowledgedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Profile = z.infer<typeof Profile>;

/** The set of active meal slots for a given meal count. */
export const MEAL_SLOTS_BY_COUNT: Record<number, MealType[]> = {
  2: ['breakfast', 'dinner'],
  3: ['breakfast', 'lunch', 'dinner'],
  4: ['breakfast', 'lunch', 'dinner', 'snack'],
  5: ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'],
};
