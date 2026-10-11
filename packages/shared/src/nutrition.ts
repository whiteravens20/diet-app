// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';

/** Macronutrient triple, grams. Used for targets and totals alike. */
export const Macros = z.object({
  protein: z.number().min(0),
  fat: z.number().min(0),
  carbs: z.number().min(0),
});
export type Macros = z.infer<typeof Macros>;

/** A full nutrition snapshot — calories plus macros. */
export const Nutrition = Macros.extend({
  calories: z.number().min(0),
});
export type Nutrition = z.infer<typeof Nutrition>;

/**
 * The nutrition of one serving as somebody types it for a meal of their own.
 * More than this in one serving is a slip of the keyboard, not a meal.
 */
export const EnteredNutrition = z.object({
  calories: z.number().min(0).max(5000),
  protein: z.number().min(0).max(500),
  fat: z.number().min(0).max(500),
  carbs: z.number().min(0).max(1000),
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
export function riskOfLosingWeight(body: { age: number; heightCm: number; weightKg: number }): ('minor' | 'underweight')[] {
  const bmi = body.weightKg / (body.heightCm / 100) ** 2;
  return [...(body.age < ADULT_AGE ? (['minor'] as const) : []), ...(bmi < UNDERWEIGHT_BMI ? (['underweight'] as const) : [])];
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
