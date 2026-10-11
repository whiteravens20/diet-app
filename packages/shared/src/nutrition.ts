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

/** The least and the most a calorie target somebody types may be, for a profile, a plan or a day. */
export const MIN_CALORIE_TARGET = 800;
export const MAX_CALORIE_TARGET = 6000;

/**
 * What a client should tell the user about a calorie target:
 *
 *  - `below_floor`: a target somebody typed is under the lowest a calculated
 *    one goes;
 *  - `below_bmr`: the target is under what the body uses at rest.
 */
export const CalorieWarning = z.enum(['below_floor', 'below_bmr']);
export type CalorieWarning = z.infer<typeof CalorieWarning>;

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
  warnings: z.array(CalorieWarning),
});
export type CalorieCalculation = z.infer<typeof CalorieCalculation>;
