import { z } from 'zod';
import { ActivityLevel, Allergen, DietType, MealType, Sex, WeeklyLossTarget } from './enums.js';

/** A single account may hold at most this many profiles. */
export const MAX_PROFILES_PER_ACCOUNT = 2;

/** Free-form preference bundle attached to a profile. */
export const ProfilePreferences = z.object({
  /** Ingredients the planner should prefer (a scoring bias, not a hard rule). */
  favoriteIngredientIds: z.array(z.string().uuid()).default([]),
  /** Ingredients the planner must skip. */
  excludedIngredientIds: z.array(z.string().uuid()).default([]),
  allergens: z.array(Allergen).default([]),
  dislikedFoods: z.array(z.string()).default([]),
  preferredCuisines: z.array(z.string()).default([]),
  /**
   * Hard cap on how many days in a row the same recipe may occupy a slot.
   * The scorer treats this as an exclusion (not a soft penalty) so even a
   * runaway "best-scoring" recipe is forced to step aside. 1 = no repeats
   * on adjacent days; higher = more meal-prep friendly. The plan generator
   * uses a permissive default when `mealPrepFriendly` is set on the
   * generation request.
   */
  maxConsecutiveDaysSameMeal: z.number().int().min(1).max(7).default(2),
  /**
   * Hard cap on how many times the same recipe may appear within any rolling
   * 7-day window. Stops a single high-scoring recipe from dominating a long
   * plan (28 days = the same meal every day was the reported failure mode).
   */
  maxTimesPerWeekSameMeal: z.number().int().min(1).max(7).default(3),
  /**
   * F15.1 anti-monotony rotation threshold. After this many consecutive
   * plan-level generations actually applied the inventory bias, the next
   * round drops the pantry preference and the counter resets — keeps a
   * leftover-heavy month from locking the user into one recipe corridor.
   * `0` disables the rotation entirely (bias every round, no cap).
   */
  inventoryBiasResetEvery: z.number().int().min(0).max(20).default(5),
});
export type ProfilePreferences = z.infer<typeof ProfilePreferences>;

/** Shared shape for create/update profile payloads. */
export const ProfileInput = z.object({
  name: z.string().min(1).max(80),
  age: z.number().int().min(13).max(120),
  sex: Sex.nullable().default(null),
  heightCm: z.number().min(100).max(250),
  weightKg: z.number().min(30).max(400),
  activityLevel: ActivityLevel.default('moderate'),
  dietType: DietType.default('balanced'),
  weeklyLossTarget: WeeklyLossTarget.nullable().default('0.5'),
  /** Manual kcal target; when set it overrides the calculated value. */
  manualCalorieTarget: z.number().int().min(800).max(6000).nullable().default(null),
  /** Default meal count (2-5) for new plans. */
  mealCount: z.number().int().min(2).max(5).default(3),
  preferences: ProfilePreferences.default({
    favoriteIngredientIds: [],
    excludedIngredientIds: [],
    allergens: [],
    dislikedFoods: [],
    preferredCuisines: [],
    maxConsecutiveDaysSameMeal: 2,
    maxTimesPerWeekSameMeal: 3,
    inventoryBiasResetEvery: 5,
  }),
});
export type ProfileInput = z.infer<typeof ProfileInput>;

/** Persisted profile as returned by the API. */
export const Profile = ProfileInput.extend({
  id: z.string().uuid(),
  userId: z.string().uuid(),
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
