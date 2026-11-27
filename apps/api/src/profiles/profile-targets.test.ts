// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { calculateCalories, macroSplitOf } from '../engine/index.js';
import { calorieInputOf, type CalorieProfile } from './calorie-input.js';
import { inForce, targetOf, type HeldTarget, type TargetFrom } from './profile-targets.js';

const profile: CalorieProfile = {
  age: 35,
  sex: 'female',
  heightCm: 168,
  weightKg: 70,
  activityLevel: 'moderate',
  dietType: 'balanced',
  customMacroSplit: null,
  customProteinPerKg: null,
  weeklyLossTarget: null,
  manualCalorieTarget: null,
  expenditureCorrectionKcal: null,
};

function aim(calories: number): HeldTarget {
  return {
    calories,
    protein: 100,
    fat: 70,
    carbs: 250,
    carbsFloor: null,
    split: macroSplitOf('balanced'),
    dietType: 'balanced',
  };
}

describe('what a profile aims at as it stands', () => {
  it('is the calorie engine’s target with its macros and the diet’s split', () => {
    const calculation = calculateCalories(calorieInputOf(profile));

    const target = targetOf(profile);

    expect(target.calories).toBe(calculation.dailyTarget);
    expect(target).toMatchObject(calculation.targetMacros);
    expect(target.split).toEqual(macroSplitOf('balanced'));
    expect(target.dietType).toBe('balanced');
  });

  it('of the custom diet takes the profile’s own split', () => {
    const own = {
      ...profile,
      dietType: 'custom' as const,
      customMacroSplit: { protein: 30, fat: 30, carbs: 40 },
    };

    const target = targetOf(own);

    expect(target.dietType).toBe('custom');
    expect(target.split.protein).toBeCloseTo(0.3, 5);
    expect(target.split.fat).toBeCloseTo(0.3, 5);
    expect(target.split.carbs).toBeCloseTo(0.4, 5);
    expect(target.calories).toBe(calculateCalories(calorieInputOf(own)).dailyTarget);
  });

  it('moves with a column it is worked out from', () => {
    expect(targetOf({ ...profile, weightKg: 90 }).calories).not.toBe(targetOf(profile).calories);
  });
});

describe('the row in force on a day', () => {
  const rows: TargetFrom[] = [
    { from: '2026-11-10', target: aim(2000) },
    { from: '2026-11-20', target: aim(1800) },
  ];

  it('is the latest from on or before it', () => {
    expect(inForce(rows, '2026-11-10')?.calories).toBe(2000);
    expect(inForce(rows, '2026-11-19')?.calories).toBe(2000);
    expect(inForce(rows, '2026-11-20')?.calories).toBe(1800);
    expect(inForce(rows, '2026-12-01')?.calories).toBe(1800);
  });

  it('is the first for a day before them all: a day written before the profile was made', () => {
    expect(inForce(rows, '2026-11-01')?.calories).toBe(2000);
  });

  it('is none without rows, and the day reads the profile as it stands', () => {
    expect(inForce([], '2026-11-15')).toBeNull();
  });
});
