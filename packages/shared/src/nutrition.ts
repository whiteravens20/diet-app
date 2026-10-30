// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { OWN_MEAL_LIMITS } from './constants.js';

/** Macronutrient triple, grams. Used for targets and totals alike. */
export const Macros = z.object({
  protein: z.number().min(0),
  fat: z.number().min(0),
  carbs: z.number().min(0),
});
export type Macros = z.infer<typeof Macros>;

/** How much the protein, fat and carbohydrate of something change, in grams: under nothing for less. */
export const MacroChange = z.object({
  protein: z.number(),
  fat: z.number(),
  carbs: z.number(),
});
export type MacroChange = z.infer<typeof MacroChange>;

/**
 * The least and the most of a day's energy that somebody's own split may
 * give to protein, to fat and to carbohydrate, in per cent. Under the least
 * of protein and of fat a diet runs short of what a body cannot make itself;
 * the rest leaves room for every diet the application names and for more.
 */
export const SPLIT_SHARE_LIMITS = {
  protein: { min: 10, max: 45 },
  fat: { min: 15, max: 75 },
  carbs: { min: 5, max: 70 },
} as const;

/**
 * Somebody's own split of a day's energy between protein, fat and
 * carbohydrate: whole per cent that add up to a hundred.
 */
export const MacroSplit = z
  .object({
    protein: z
      .number()
      .int()
      .min(SPLIT_SHARE_LIMITS.protein.min)
      .max(SPLIT_SHARE_LIMITS.protein.max),
    fat: z.number().int().min(SPLIT_SHARE_LIMITS.fat.min).max(SPLIT_SHARE_LIMITS.fat.max),
    carbs: z.number().int().min(SPLIT_SHARE_LIMITS.carbs.min).max(SPLIT_SHARE_LIMITS.carbs.max),
  })
  .refine((split) => split.protein + split.fat + split.carbs === 100, {
    message: 'The three shares have to add up to 100.',
  });
export type MacroSplit = z.infer<typeof MacroSplit>;

/** A full nutrition snapshot — calories plus macros. */
export const Nutrition = Macros.extend({
  calories: z.number().min(0),
});
export type Nutrition = z.infer<typeof Nutrition>;

/** The nutrition of one serving as somebody types it for a meal of their own, at most `OWN_MEAL_LIMITS.perServing`. */
export const EnteredNutrition = z.object({
  calories: z.number().min(0).max(OWN_MEAL_LIMITS.perServing.calories),
  protein: z.number().min(0).max(OWN_MEAL_LIMITS.perServing.protein),
  fat: z.number().min(0).max(OWN_MEAL_LIMITS.perServing.fat),
  carbs: z.number().min(0).max(OWN_MEAL_LIMITS.perServing.carbs),
});
export type EnteredNutrition = z.infer<typeof EnteredNutrition>;

/** The least and the most a calorie target somebody types may be, for a profile, a plan or a day. */
export const MIN_CALORIE_TARGET = 800;
export const MAX_CALORIE_TARGET = 6000;

/**
 * What a client should tell the user about a calorie target:
 *
 *  - `minor`: under 18. The equation behind the figures is one for adults,
 *    so they are an approximation, and losing weight is a matter for a doctor;
 *  - `underweight`: a body-mass index under 18.5;
 *  - `below_floor`: a target somebody typed is under the lowest a calculated
 *    one goes;
 *  - `below_bmr`: the target is under what the body uses at rest.
 */
export const CalorieWarning = z.enum(['minor', 'underweight', 'below_floor', 'below_bmr']);
export type CalorieWarning = z.infer<typeof CalorieWarning>;

/** Under this age the equation behind the figures is an approximation, and a loss goal needs the user's word. */
export const ADULT_AGE = 18;
/** A body-mass index under this is underweight. */
export const UNDERWEIGHT_BMI = 18.5;

/**
 * Why losing weight is a risk for this body: under 18, underweight, both or
 * neither. Somebody for whom it is has to say they understand before a loss
 * goal is planned.
 */
export function riskOfLosingWeight(body: {
  age: number;
  heightCm: number;
  weightKg: number;
}): ('minor' | 'underweight')[] {
  const bmi = body.weightKg / (body.heightCm / 100) ** 2;
  return [
    ...(body.age < ADULT_AGE ? (['minor'] as const) : []),
    ...(bmi < UNDERWEIGHT_BMI ? (['underweight'] as const) : []),
  ];
}

/**
 * Result of the deterministic calorie engine. Every field is reproducible from
 * profile inputs; `source` tags whether the daily target was derived or
 * manually overridden so the UI can explain it.
 */
export const CalorieCalculation = z.object({
  bmr: z.number(), // Mifflin-St Jeor basal metabolic rate
  maintenance: z.number(), // bmr * activity multiplier (TDEE)
  weeklyLossTarget: z.enum(['0.25', '0.5', '0.75', '1.0']).nullable(),
  /** kcal a day the chosen pace asks for, before any limit. */
  requestedDeficit: z.number(),
  /** How far the target really is under maintenance; negative when a typed target is above it. */
  dailyDeficit: z.number(),
  dailyTarget: z.number(), // final calorie target
  targetMacros: Macros,
  source: z.enum(['calculated', 'manual_override']),
  /** The lowest a calculated target goes for this profile. */
  safetyFloor: z.number(),
  /** The pace asked for more than a quarter of maintenance, and was slowed to that. */
  deficitCapped: z.boolean(),
  /** The target was raised to the floor. */
  safetyFloorApplied: z.boolean(),
  /** Maintenance itself is under the floor: no loss is planned, the target is maintenance. */
  maintenanceUnderFloor: z.boolean(),
  /**
   * The profile asks to lose weight, is under 18 or underweight, and has not
   * said it understands the risk: the target is held at maintenance until it
   * does (`acknowledgeRisk` on the profile).
   */
  goalHeld: z.boolean(),
  warnings: z.array(CalorieWarning),
});
export type CalorieCalculation = z.infer<typeof CalorieCalculation>;
