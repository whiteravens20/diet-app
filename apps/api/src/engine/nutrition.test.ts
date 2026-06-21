import { describe, expect, it } from 'vitest';
import {
  calculateBmr,
  calculateCalories,
  calculateMaintenance,
  dayTypeCalorieTarget,
  deficitForWeeklyTarget,
  macrosForCalories,
} from './nutrition.js';

describe('dayTypeCalorieTarget (F17 periodisation)', () => {
  it('leaves a normal / undefined day at the base target', () => {
    expect(dayTypeCalorieTarget(2000, 'normal')).toBe(2000);
    expect(dayTypeCalorieTarget(2000, undefined)).toBe(2000);
  });

  it('adds a surplus on training days and a deficit on rest days', () => {
    expect(dayTypeCalorieTarget(2000, 'training')).toBe(2300); // +15%
    expect(dayTypeCalorieTarget(2000, 'rest')).toBe(1700); // -15%
  });

  it('rounds to a tidy 10 kcal', () => {
    // 2209 * 1.15 = 2540.35 → 2540
    expect(dayTypeCalorieTarget(2209, 'training')).toBe(2540);
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
