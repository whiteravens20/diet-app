// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { energySplit } from './energy-split';

describe("the split of a day's energy", () => {
  it('is what each macronutrient gives at 4, 9 and 4 kcal a gram, not what it weighs', () => {
    // 150 g, 70 g and 200 g weigh 36%, 17% and 48% of the total; their energy is 600, 630 and 800 kcal.
    expect(energySplit({ protein: 150, fat: 70, carbs: 200 })).toEqual([
      { key: 'protein', grams: 150, kcal: 600, percent: 30 },
      { key: 'fat', grams: 70, kcal: 630, percent: 31 },
      { key: 'carbs', grams: 200, kcal: 800, percent: 39 },
    ]);
  });

  it('gives whole percents that add up to a hundred, the remainders going to the largest', () => {
    // A third each: 33.3% three times rounds to 99.
    const parts = energySplit({ protein: 100, fat: 400 / 9, carbs: 100 })!;

    expect(parts.map((part) => part.percent)).toEqual([34, 33, 33]);
    expect(parts.reduce((sum, part) => sum + part.percent, 0)).toBe(100);
  });

  it('shows the split a target was made from, within the rounding of its grams', () => {
    // 2000 kcal at 30/30/40 is 150 g, 67 g and 200 g.
    expect(energySplit({ protein: 150, fat: 67, carbs: 200 })!.map((part) => part.percent)).toEqual(
      [30, 30, 40],
    );
  });

  it('is nothing for nothing', () => {
    expect(energySplit({ protein: 0, fat: 0, carbs: 0 })).toBeNull();
  });
});
