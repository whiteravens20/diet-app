// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  calculateCalories,
  ownSplit,
  proteinKcalOf,
  wholePercent,
  type CalorieEngineInput,
} from './nutrition.js';

/** 25 % protein, 30 % fat, 45 % carbohydrate, as shares of one. */
const SPLIT = { protein: 0.25, fat: 0.3, carbs: 0.45 };

describe("the custom diet's split of a day", () => {
  it('is the split as it is where the profile sets no protein of its own', () => {
    expect(ownSplit(SPLIT, null, 2000)).toEqual({ shares: SPLIT, held: false });
  });

  it('gives protein the energy of its grams, fat its share and carbohydrate the rest', () => {
    // 1.6 g a kilogram of 70 kg: 112 g, 448 kcal of 2000.
    const { shares, held } = ownSplit(SPLIT, proteinKcalOf(1.6, 70), 2000);

    expect(held).toBe(false);
    expect(shares.protein).toBeCloseTo(0.224, 9);
    expect(shares.fat).toBe(0.3);
    expect(shares.carbs).toBeCloseTo(0.476, 9);
  });

  it('keeps the grams of protein whatever the calories of the day, the rest moving', () => {
    const usual = ownSplit(SPLIT, proteinKcalOf(1.6, 70), 2000).shares;
    const training = ownSplit(SPLIT, proteinKcalOf(1.6, 70), 2300).shares;

    expect(usual.protein * 2000).toBeCloseTo(training.protein * 2300, 6);
    expect(training.fat).toBe(usual.fat);
    expect(training.carbs).toBeGreaterThan(usual.carbs);
  });

  it.each([
    // 0.8 g a kilogram of 60 kg is 192 kcal: under a tenth of 2200.
    ['protein under its least', proteinKcalOf(0.8, 60), 2200, SPLIT, 0.1],
    // 3 g a kilogram of 120 kg is 1440 kcal: over 45 % of 1800.
    ['protein over its most', proteinKcalOf(3, 120), 1800, SPLIT, 0.45],
    // Fat at 15 % and protein at a tenth would leave carbohydrate 75 %, over its 70.
    ['carbohydrate over its most', proteinKcalOf(0.8, 60), 2200, { ...SPLIT, fat: 0.15 }, 0.15],
    // Fat at 75 % and protein at 30 % would leave carbohydrate nothing, under its 5.
    ['carbohydrate under its least', proteinKcalOf(2.5, 60), 1500, { ...SPLIT, fat: 0.75 }, 0.2],
  ])('holds %s at the limit, and says so', (_, kcal, calories, split, protein) => {
    const { shares, held } = ownSplit(split, kcal, calories);

    expect(held).toBe(true);
    expect(shares.protein).toBeCloseTo(protein, 9);
    expect(shares.fat).toBe(split.fat);
    expect(shares.protein + shares.fat + shares.carbs).toBeCloseTo(1, 9);
    expect(shares.protein).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(shares.protein).toBeLessThanOrEqual(0.45 + 1e-9);
    expect(shares.carbs).toBeGreaterThanOrEqual(0.05 - 1e-9);
    expect(shares.carbs).toBeLessThanOrEqual(0.7 + 1e-9);
  });
});

describe('shares as whole per cent', () => {
  it.each([
    [
      { protein: 0.224, fat: 0.3, carbs: 0.476 },
      { protein: 22, fat: 30, carbs: 48 },
    ],
    [
      { protein: 1 / 3, fat: 1 / 3, carbs: 1 / 3 },
      { protein: 34, fat: 33, carbs: 33 },
    ],
    [
      { protein: 0.25, fat: 0.3, carbs: 0.45 },
      { protein: 25, fat: 30, carbs: 45 },
    ],
  ])('add up to a hundred, each as near its share as that allows: %o', (shares, percent) => {
    const whole = wholePercent(shares);

    expect(whole).toEqual(percent);
    expect(whole.protein + whole.fat + whole.carbs).toBe(100);
  });
});

describe('the target of a profile on the custom diet with protein per kilogram', () => {
  const input = (over: Partial<CalorieEngineInput> = {}): CalorieEngineInput => ({
    age: 34,
    sex: 'female',
    heightCm: 168,
    weightKg: 70,
    activityLevel: 'moderate',
    dietType: 'custom',
    customMacroSplit: SPLIT,
    customProteinPerKg: 1.6,
    weeklyLossTarget: null,
    manualCalorieTarget: 2000,
    riskAcknowledged: false,
    ...over,
  });

  it("aims at the grams of protein of the body's weight, fat its share and carbohydrate the rest", () => {
    const calculation = calculateCalories(input());

    expect(calculation.targetMacros).toEqual({ protein: 112, fat: 67, carbs: 238 });
    expect(calculation.customSplitHeld).toBe(false);
  });

  it('moves with the weight', () => {
    expect(calculateCalories(input({ weightKg: 80 })).targetMacros.protein).toBe(128);
  });

  it('says where the weight takes protein past a limit, held there', () => {
    const calculation = calculateCalories(input({ weightKg: 150, customProteinPerKg: 3 }));

    // 450 g would be 90 % of 2000: held at 45 %, 225 g.
    expect(calculation.targetMacros.protein).toBe(225);
    expect(calculation.customSplitHeld).toBe(true);
  });

  it('is the split as it is without protein per kilogram, and held nowhere on another diet', () => {
    expect(calculateCalories(input({ customProteinPerKg: null })).targetMacros).toEqual({
      protein: 125,
      fat: 67,
      carbs: 225,
    });
    expect(calculateCalories(input({ dietType: 'keto' })).customSplitHeld).toBe(false);
  });
});
