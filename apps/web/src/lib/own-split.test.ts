// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { perKgSplit, wholePercent } from './own-split';

describe("the custom diet's ways, worked out in the form", () => {
  it('rounds shares the way that misses them least', () => {
    expect(wholePercent({ protein: 1 / 3, fat: 1 / 3, carbs: 1 / 3 })).toEqual({
      protein: 34,
      fat: 33,
      carbs: 33,
    });
  });

  it('gives protein per kilogram the grams of the weight, fat its share and carbohydrate the rest, as the API does', () => {
    // 1.6 g a kilogram of 80 kg at 2400 kcal: 128 g, 512 kcal; the API answers 21, 30 and 49 for it.
    const at = perKgSplit(1.6, 30, 80, 2400);

    expect(at.protein).toBeCloseTo(128, 9);
    expect(at.split).toEqual({ protein: 21, fat: 30, carbs: 49 });
    expect(at.held).toBe(false);
  });

  it('holds protein at a limit and names the grams a kilogram that fit, as the API refuses them', () => {
    // 3 g a kilogram of 80 kg at 1800 kcal is 53 %: past 45; the API names 0.8 to 2.5 g.
    const past = perKgSplit(3, 30, 80, 1800);

    expect(past.held).toBe(true);
    expect(past.split.protein).toBe(45);
    expect(past.fits).toEqual({ from: 0.8, to: 2.5 });
  });

  it('names no grams where none fit', () => {
    // Fat at 75 % leaves protein at most 20 %, and at 1000 kcal and 200 kg even 0.8 g a kilogram is past it.
    expect(perKgSplit(0.8, 75, 200, 1000).fits).toBeNull();
  });
});
