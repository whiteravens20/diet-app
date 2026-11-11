// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { macrosOff } from './plan-days.js';

describe('whether a day is far from its split', () => {
  // 150 g of protein, 145 g of fat and 20 g of carbohydrate: protein on low-carb's share, carbohydrate at a twentieth.
  const eggsAndFish = { protein: 150, fat: 145, carbs: 20 };

  it('is not said of a low-carb or keto day under its carbohydrate that holds its protein', () => {
    expect(macrosOff(eggsAndFish, { dietType: 'low_carb', macroSplit: null })).toBe(false);
    expect(
      macrosOff({ protein: 125, fat: 160, carbs: 15 }, { dietType: 'keto', macroSplit: null }),
    ).toBe(false);
  });

  it('is said of that day where carbohydrate is an aim, and of a low-carb day short of protein or over its carbohydrate', () => {
    expect(macrosOff(eggsAndFish, { dietType: 'balanced', macroSplit: null })).toBe(true);
    expect(
      macrosOff(eggsAndFish, {
        dietType: 'custom',
        macroSplit: { protein: 30, fat: 50, carbs: 20 },
      }),
    ).toBe(true);
    expect(
      macrosOff({ protein: 50, fat: 160, carbs: 20 }, { dietType: 'low_carb', macroSplit: null }),
    ).toBe(true);
    expect(
      macrosOff({ protein: 100, fat: 80, carbs: 200 }, { dietType: 'low_carb', macroSplit: null }),
    ).toBe(true);
  });

  it("goes by the day's own aim where it has one", () => {
    // The grams a low-carb day aims at: 30/50/20 of 2000 kcal.
    const aim = { protein: 150, fat: 111, carbs: 100 };
    expect(macrosOff(eggsAndFish, { dietType: 'low_carb', macroSplit: null }, aim)).toBe(false);
    expect(macrosOff(eggsAndFish, { dietType: 'balanced', macroSplit: null }, aim)).toBe(true);
  });
});
