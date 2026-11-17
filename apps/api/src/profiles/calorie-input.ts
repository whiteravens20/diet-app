// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Profile } from '@prisma/client';
import { storedSplit } from '../common/stored-split.js';
import { sharesOf, type CalorieEngineInput } from '../engine/index.js';

/** What the calorie engine reads of a profile, as the profile is kept; the split as whatever its JSON holds. */
export type CalorieProfile = Pick<
  Profile,
  | 'age'
  | 'sex'
  | 'heightCm'
  | 'weightKg'
  | 'activityLevel'
  | 'dietType'
  | 'customProteinPerKg'
  | 'weeklyLossTarget'
  | 'manualCalorieTarget'
  | 'riskAcknowledgedAt'
  | 'expenditureCorrectionKcal'
> & { customMacroSplit: unknown };

/** What the calorie engine reads of a profile, as the profile is kept. */
export function calorieInputOf(profile: CalorieProfile): CalorieEngineInput {
  return {
    age: profile.age,
    sex: profile.sex,
    heightCm: profile.heightCm,
    weightKg: profile.weightKg,
    activityLevel: profile.activityLevel,
    dietType: profile.dietType,
    customMacroSplit: sharesOf(storedSplit(profile.customMacroSplit)),
    customProteinPerKg: profile.customProteinPerKg,
    weeklyLossTarget: profile.weeklyLossTarget as CalorieEngineInput['weeklyLossTarget'],
    manualCalorieTarget: profile.manualCalorieTarget,
    riskAcknowledged: profile.riskAcknowledgedAt !== null,
    expenditureCorrection: profile.expenditureCorrectionKcal ?? 0,
  };
}
