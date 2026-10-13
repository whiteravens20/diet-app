// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  calculateBmr,
  calculateCalories,
  calculateMaintenance,
  deficitForWeeklyTarget,
  effectiveDayTarget,
  energyShares,
  macroSplitOf,
  macrosForCalories,
  sharesOf,
  splitDistance,
  type CalorieEngineInput,
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

  it('does not take a day\'s own target under maintenance while the profile\'s loss goal is held', () => {
    expect(day({ ownTarget: 900, holdUnder: 2000 })).toEqual({ target: 2000, belowFloor: false });
    expect(day({ ownTarget: 2300, holdUnder: 2000 }).target).toBe(2300);
    expect(day({ ownTarget: 900, holdUnder: null }).target).toBe(900);
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
  const person = (over: Partial<CalorieEngineInput> = {}): CalorieEngineInput => ({
    age: 30,
    sex: 'male',
    heightCm: 180,
    weightKg: 80,
    activityLevel: 'moderate',
    dietType: 'balanced',
    weeklyLossTarget: '0.5',
    manualCalorieTarget: null,
    riskAcknowledged: false,
    ...over,
  });

  it('splits the target of somebody on the custom diet as they said, and as the balanced diet until they have', () => {
    const balanced = calculateCalories(person()).targetMacros;

    expect(calculateCalories(person({ dietType: 'custom' })).targetMacros).toEqual(balanced);
    // 2,209 kcal: 30 % and 30 % at four a gram, 40 % at nine.
    expect(calculateCalories(person({ dietType: 'custom', customMacroSplit: { protein: 0.3, fat: 0.4, carbs: 0.3 } })).targetMacros).toEqual({ protein: 166, fat: 98, carbs: 166 });
    // The split is the custom diet's: it changes nothing for somebody on another.
    expect(calculateCalories(person({ customMacroSplit: { protein: 0.3, fat: 0.4, carbs: 0.3 } })).targetMacros).toEqual(balanced);
  });

  it('derives the target as maintenance minus the deficit of the pace', () => {
    const r = calculateCalories(person());

    expect(r).toMatchObject({
      maintenance: 2759,
      requestedDeficit: 550,
      dailyDeficit: 550,
      dailyTarget: 2209,
      source: 'calculated',
      safetyFloor: 1500,
      deficitCapped: false,
      safetyFloorApplied: false,
      maintenanceUnderFloor: false,
      goalHeld: false,
      warnings: [],
    });
  });

  it('slows a pace that asks for more than a quarter of maintenance, and says so', () => {
    // 190 cm, 113 kg, sedentary, sex not given: BMR 2090, maintenance 2508. A kilogram a week asks for 1100.
    const r = calculateCalories(person({ sex: null, heightCm: 190, weightKg: 113, activityLevel: 'sedentary', weeklyLossTarget: '1.0' }));

    expect(r).toMatchObject({ maintenance: 2508, requestedDeficit: 1100, dailyDeficit: 627, dailyTarget: 1881, deficitCapped: true, safetyFloorApplied: false });
    // Without the limit the target would have been 56 % of maintenance.
    expect(r.dailyTarget / r.maintenance).toBeCloseTo(0.75, 2);
  });

  it('never goes under the floor, and the deficit it reports is the real one', () => {
    // BMR 1239, maintenance 1487; a quarter of it would leave 1115.
    const r = calculateCalories(person({ sex: 'female', heightCm: 160, weightKg: 55, activityLevel: 'sedentary', weeklyLossTarget: '1.0' }));

    expect(r).toMatchObject({ maintenance: 1487, dailyTarget: 1200, dailyDeficit: 287, requestedDeficit: 1100, safetyFloor: 1200, safetyFloorApplied: true, deficitCapped: true, maintenanceUnderFloor: false });
  });

  it('never goes above maintenance: where maintenance is under the floor, no loss is planned', () => {
    // BMR 827, maintenance 992.
    for (const weeklyLossTarget of [null, '0.25', '0.5'] as const) {
      const r = calculateCalories(person({ age: 80, sex: 'female', heightCm: 150, weightKg: 45, activityLevel: 'sedentary', weeklyLossTarget }));

      expect(r).toMatchObject({ maintenance: 992, dailyTarget: 992, dailyDeficit: 0, maintenanceUnderFloor: true, safetyFloorApplied: false });
    }
  });

  it('honours a target somebody typed, and says how far it is from maintenance', () => {
    expect(calculateCalories(person({ manualCalorieTarget: 1800 }))).toMatchObject({ dailyTarget: 1800, source: 'manual_override', dailyDeficit: 959, warnings: [] });
    expect(calculateCalories(person({ manualCalorieTarget: 3000 })).dailyDeficit).toBe(-241);
  });

  it('flags a typed target under the floor or under what the body uses at rest', () => {
    // BMR 1780, floor 1500.
    expect(calculateCalories(person({ manualCalorieTarget: 1600 })).warnings).toEqual(['below_bmr']);
    expect(calculateCalories(person({ manualCalorieTarget: 900 })).warnings).toEqual(['below_floor', 'below_bmr']);
  });

  describe('for somebody under 18 or underweight', () => {
    // 16 years, 165 cm, 55 kg: BMI 20.2. 25 years, 170 cm, 50 kg: BMI 17.3.
    const minor = (over: Partial<CalorieEngineInput> = {}) => person({ age: 16, sex: 'female', heightCm: 165, weightKg: 55, weeklyLossTarget: '1.0', ...over });
    const underweight = (over: Partial<CalorieEngineInput> = {}) => person({ age: 25, sex: 'female', heightCm: 170, weightKg: 50, weeklyLossTarget: '0.5', ...over });

    it('warns, and holds a loss goal at maintenance until the risk is acknowledged', () => {
      for (const [input, warning] of [[minor(), 'minor'], [underweight(), 'underweight']] as const) {
        const r = calculateCalories(input);

        expect(r).toMatchObject({ goalHeld: true, dailyTarget: r.maintenance, dailyDeficit: 0, warnings: [warning] });
        expect(r.requestedDeficit).toBeGreaterThan(0);
      }
    });

    it('applies the goal once it is acknowledged, and still warns', () => {
      const r = calculateCalories(minor({ riskAcknowledged: true }));

      expect(r.goalHeld).toBe(false);
      expect(r.dailyTarget).toBeLessThan(r.maintenance);
      expect(r.dailyTarget).toBeGreaterThanOrEqual(r.safetyFloor);
      expect(r.warnings).toContain('minor');
    });

    it('holds a typed target under maintenance the same way, and leaves one at or above it alone', () => {
      const held = calculateCalories(underweight({ manualCalorieTarget: 1200 }));
      expect(held).toMatchObject({ goalHeld: true, dailyTarget: held.maintenance, source: 'manual_override' });

      const maintenance = held.maintenance;
      expect(calculateCalories(underweight({ manualCalorieTarget: maintenance + 200 }))).toMatchObject({ goalHeld: false, dailyTarget: maintenance + 200 });
      expect(calculateCalories(underweight({ manualCalorieTarget: 1200, riskAcknowledged: true }))).toMatchObject({ goalHeld: false, dailyTarget: 1200 });
    });

    it('holds nothing where no loss is asked for', () => {
      expect(calculateCalories(minor({ weeklyLossTarget: null }))).toMatchObject({ goalHeld: false, warnings: ['minor'] });
    });

    it('names both when both are true', () => {
      expect(calculateCalories(minor({ weightKg: 45, weeklyLossTarget: null })).warnings).toEqual(['minor', 'underweight']);
    });
  });
});

describe('the split of energy between protein, fat and carbohydrate', () => {
  it('is what each carries of the energy the three hold: four, nine and four kilocalories a gram', () => {
    // 50 g of protein, 20 g of fat and 55 g of carbohydrate: 200, 180 and 220 kcal of 600.
    const shares = energyShares({ protein: 50, fat: 20, carbs: 55 })!;

    expect(shares.protein).toBeCloseTo(200 / 600);
    expect(shares.fat).toBeCloseTo(180 / 600);
    expect(shares.carbs).toBeCloseTo(220 / 600);
  });

  it('is not there for nothing at all', () => {
    expect(energyShares({ protein: 0, fat: 0, carbs: 0 })).toBeNull();
  });

  it('is as far from another as the share of energy that would have to move', () => {
    const balanced = macroSplitOf('balanced');

    expect(splitDistance(balanced, balanced)).toBe(0);
    // 10 points from carbohydrate to protein.
    expect(splitDistance(balanced, macroSplitOf('high_protein'))).toBeCloseTo(0.1);
    expect(splitDistance({ protein: 1, fat: 0, carbs: 0 }, { protein: 0, fat: 1, carbs: 0 })).toBe(1);
  });

  it('is, for the custom diet, the one its profile said, and the balanced one until it has said one', () => {
    const own = { protein: 0.3, fat: 0.4, carbs: 0.3 };

    expect(macroSplitOf('custom')).toEqual(macroSplitOf('balanced'));
    expect(macroSplitOf('custom', null)).toEqual(macroSplitOf('balanced'));
    expect(macroSplitOf('custom', own)).toEqual(own);
    // Another diet keeps its own, whatever a profile keeps for the custom one.
    expect(macroSplitOf('keto', own)).toEqual(macroSplitOf('keto'));
    // 600, 800 and 600 of 2,000 kcal, at four, nine and four a gram.
    expect(macrosForCalories(2000, 'custom', own)).toEqual({ protein: 150, fat: 89, carbs: 150 });
    expect(macrosForCalories(2000, 'keto', own)).toEqual(macrosForCalories(2000, 'keto'));
  });

  it('is kept in whole per cent and worked with as shares of one', () => {
    expect(sharesOf({ protein: 30, fat: 40, carbs: 30 })).toEqual({ protein: 0.3, fat: 0.4, carbs: 0.3 });
    expect(sharesOf(null)).toBeNull();
    expect(sharesOf(undefined)).toBeNull();
  });

  it('is given for every diet, and adds up to the whole', () => {
    for (const diet of ['balanced', 'high_protein', 'low_carb', 'vegetarian', 'vegan', 'keto', 'mediterranean', 'custom'] as const) {
      const { protein, fat, carbs } = macroSplitOf(diet);
      expect(protein + fat + carbs).toBeCloseTo(1);
    }
  });
});
