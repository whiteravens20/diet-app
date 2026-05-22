import { z } from 'zod';
import { ActivityLevel, Allergen, DietType, MealType, Sex, WeeklyLossTarget } from './enums.js';

/** Free-form preference bundle attached to a profile. */
export const ProfilePreferences = z.object({
  excludedIngredientIds: z.array(z.string().uuid()).default([]),
  allergens: z.array(Allergen).default([]),
  dislikedFoods: z.array(z.string()).default([]),
  preferredCuisines: z.array(z.string()).default([]),
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
    excludedIngredientIds: [],
    allergens: [],
    dislikedFoods: [],
    preferredCuisines: [],
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
