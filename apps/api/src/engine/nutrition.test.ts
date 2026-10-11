// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  calculateBmr,
  calculateCalories,
  calculateMaintenance,
  deficitForWeeklyTarget,
  effectiveDayTarget,
  macrosForCalories,
} from './nutrition.js';

describe('the target of one day', () => {
  /** A day of a plan whose base the engine calculated, for somebody whose floor is 1200. */
  const day = (over: Partial<Parameters<typeof effectiveDayTarget>[0]> = {}) => effectiveDayTarget({ base: 2000, baseIsCalculated: true, floor: 1200, ...over });

  it('is the base on a normal day', () => {
    expect(day({ dayType: 'normal' })).toEqual({ target: 2000, belowFloor: false });
    expect(day()).toEqual({ target: 2000, belowFloor: false });
  });

  it('is more on a training day and less on a rest day, rounded to ten', () => {
    expect(day({ dayType: 'training' }).target).toBe(2300);
    expect(day({ dayType: 'rest' }).target).toBe(1700);
    // 2209 × 1.15 = 2540.35
    expect(day({ base: 2209, dayType: 'training' }).target).toBe(2540);
  });

  it('is not taken under the floor by a rest day when the base was calculated', () => {
    expect(day({ base: 1200, dayType: 'rest' })).toEqual({ target: 1200, belowFloor: false });
    expect(day({ base: 1500, floor: 1500, dayType: 'rest' })).toEqual({ target: 1500, belowFloor: false });
    expect(day({ base: 1350, dayType: 'rest' }).target).toBe(1200);
  });

  it('follows a base somebody typed under the floor, flagged, but never under the least a target may be', () => {
    expect(day({ base: 1000, baseIsCalculated: false, dayType: 'normal' })).toEqual({ target: 1000, belowFloor: true });
    // 800 × 0.85 = 680: under what the contract takes for a target.
    expect(day({ base: 800, baseIsCalculated: false, dayType: 'rest' })).toEqual({ target: 800, belowFloor: true });
    expect(day({ base: 1300, baseIsCalculated: false, dayType: 'rest' })).toEqual({ target: 1110, belowFloor: true });
  });

  it('is the day\'s own target when the user set one, whatever the kind of day, flagged under the floor', () => {
    expect(day({ ownTarget: 900, dayType: 'training' })).toEqual({ target: 900, belowFloor: true });
    expect(day({ ownTarget: 2600, dayType: 'rest' })).toEqual({ target: 2600, belowFloor: false });
  });
});

describe('calculateBmr (Mifflin-St Jeor)', () => {
  it('matches the known male reference value', () => {
    // 80 kg, 180 cm, 30 y, male → 10*80 + 6.25*180 - 5*30 + 5 = 1780
    expect(calculateBmr({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' })).toBe(1780);
  });

  it('matches the known female reference value', () => {
    // 65 kg, 165 cm, 30 y, female → 650 + 1031.25 - 150 - 161 = 1370.25 → 1370
    expect(calculateBmr({ weightKg: 65, heightCm: 165, age: 30, sex: 'female' })).toBe(1370);
  });

  it('uses the unbiased midpoint offset when sex is unknown', () => {
    const known = calculateBmr({ weightKg: 70, heightCm: 170, age: 30, sex: null });
    const male = calculateBmr({ weightKg: 70, heightCm: 170, age: 30, sex: 'male' });
    const female = calculateBmr({ weightKg: 70, heightCm: 170, age: 30, sex: 'female' });
    expect(known).toBe(Math.round((male + female) / 2));
  });
});

describe('calculateMaintenance', () => {
  it('applies the activity multiplier', () => {
    expect(calculateMaintenance(1780, 'moderate')).toBe(2759); // 1780 * 1.55
    expect(calculateMaintenance(1780, 'sedentary')).toBe(2136); // 1780 * 1.2
  });
});

describe('deficitForWeeklyTarget', () => {
  it('converts weekly fat-loss kg to a daily kcal deficit', () => {
    expect(deficitForWeeklyTarget('0.5')).toBe(550); // 0.5*7700/7
    expect(deficitForWeeklyTarget('1.0')).toBe(1100);
    expect(deficitForWeeklyTarget('0.25')).toBe(275);
    expect(deficitForWeeklyTarget(null)).toBe(0);
  });
});

describe('macrosForCalories', () => {
  it('splits calories into grams that re-sum to the calorie total', () => {
    const m = macrosForCalories(2000, 'balanced');
    const kcal = m.protein * 4 + m.fat * 9 + m.carbs * 4;
    expect(Math.abs(kcal - 2000)).toBeLessThan(15); // rounding tolerance
  });

  it('keto allocates most calories to fat', () => {
    const m = macrosForCalories(2000, 'keto');
    expect(m.fat * 9).toBeGreaterThan(2000 * 0.6);
  });
});

describe('calculateCalories', () => {
  const base = {
    age: 30,
    sex: 'male' as const,
    heightCm: 180,
    weightKg: 80,
    activityLevel: 'moderate' as const,
    dietType: 'balanced' as const,
  };

  it('derives the target as maintenance minus the deficit', () => {
    const r = calculateCalories({ ...base, weeklyLossTarget: '0.5', manualCalorieTarget: null });
    expect(r.maintenance).toBe(2759);
    expect(r.dailyDeficit).toBe(550);
    expect(r.dailyTarget).toBe(2209);
    expect(r.source).toBe('calculated');
    expect(r.safetyFloorApplied).toBe(false);
  });

  it('clamps to the safety floor for aggressive deficits', () => {
    const r = calculateCalories({
      ...base,
      sex: 'female',
      weightKg: 50,
      activityLevel: 'sedentary',
      weeklyLossTarget: '1.0',
      manualCalorieTarget: null,
    });
    expect(r.dailyTarget).toBe(1200);
    expect(r.safetyFloorApplied).toBe(true);
  });

  it('honours a manual override verbatim', () => {
    const r = calculateCalories({ ...base, weeklyLossTarget: '0.5', manualCalorieTarget: 1800 });
    expect(r.dailyTarget).toBe(1800);
    expect(r.source).toBe('manual_override');
  });
});
