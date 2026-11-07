// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { WeeklyLossTarget } from '@diet-app/shared';
import { calculateCalories, type CalorieEngineInput } from '../engine/index.js';

/** What a plan's base target is worked out from, of a profile. */
export type BaseProfile = Omit<
  CalorieEngineInput,
  'weeklyLossTarget' | 'riskAcknowledged' | 'customMacroSplit' | 'expenditureCorrection'
> & {
  weeklyLossTarget: string | null;
  riskAcknowledgedAt: Date | null;
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
  /** Maintenance, when the profile's loss goal is held: no day goes under it by a target of its own. */
  holdUnder: number | null;
}

/**
 * The base target of a plan for this profile, and how it came about. A
 * target typed for the plan stands in for the one typed on the profile.
 */
export function planBaseOf(profile: BaseProfile, typedForThePlan?: number): PlanBase {
  const riskAcknowledged = profile.riskAcknowledgedAt !== null;
  const calories = calculateCalories({
    age: profile.age,
    sex: profile.sex,
    heightCm: profile.heightCm,
    weightKg: profile.weightKg,
    activityLevel: profile.activityLevel,
    dietType: profile.dietType,
    weeklyLossTarget: profile.weeklyLossTarget as WeeklyLossTarget | null,
    manualCalorieTarget: typedForThePlan ?? profile.manualCalorieTarget,
    riskAcknowledged,
    expenditureCorrection: profile.expenditureCorrectionKcal ?? 0,
  });
  const atRisk = calories.warnings.includes('minor') || calories.warnings.includes('underweight');
  return {
    target: calories.dailyTarget,
    // A goal that is held is planned as maintenance, which the engine worked out.
    calculated: calories.source === 'calculated' || calories.goalHeld,
    floor: calories.safetyFloor,
    holdUnder: atRisk && !riskAcknowledged ? calories.maintenance : null,
  };
}
