// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { WeeklyLossTarget } from '@diet-app/shared';
import {
  calculateBmr,
  calculateCalories,
  calculateMaintenance,
  type CalorieEngineInput,
} from '../engine/index.js';

/** What a plan's base target is worked out from, of a profile. */
export type BaseProfile = Omit<
  CalorieEngineInput,
  'weeklyLossTarget' | 'customMacroSplit' | 'expenditureCorrection'
> & {
  weeklyLossTarget: string | null;
  expenditureCorrectionKcal: number | null;
};

/**
 * The base target of a plan and how it came about: what the target of each
 * of its days is decided from.
 */
export interface PlanBase {
  target: number;
  /** Worked out by the engine, not typed by somebody. */
  calculated: boolean;
  floor: number;
  /**
   * Maintenance, for a profile planned no loss (under 18 or underweight): no day goes under it by a target of its
   * own. The more of the formula's and the corrected one, as the engine holds the profile's target.
   */
  holdUnder: number | null;
  /** The least a target typed for the plan or for one of its days may be, for this body. */
  least: number;
}

/**
 * The base target of a plan for this profile, and how it came about. A
 * target typed for the plan stands in for the one typed on the profile.
 */
export function planBaseOf(profile: BaseProfile, typedForThePlan?: number): PlanBase {
  const calories = calculateCalories({
    age: profile.age,
    sex: profile.sex,
    heightCm: profile.heightCm,
    weightKg: profile.weightKg,
    activityLevel: profile.activityLevel,
    dietType: profile.dietType,
    weeklyLossTarget: profile.weeklyLossTarget as WeeklyLossTarget | null,
    manualCalorieTarget: typedForThePlan ?? profile.manualCalorieTarget,
    expenditureCorrection: profile.expenditureCorrectionKcal ?? 0,
  });
  const atRisk = calories.warnings.includes('minor') || calories.warnings.includes('underweight');
  return {
    target: calories.dailyTarget,
    // A goal that is held is planned as maintenance, which the engine worked out.
    calculated: calories.source === 'calculated' || calories.goalHeld,
    floor: calories.safetyFloor,
    holdUnder: atRisk
      ? Math.max(calories.maintenance, calculateMaintenance(calculateBmr(profile), profile))
      : null,
    least: calories.leastTypedTarget,
  };
}
