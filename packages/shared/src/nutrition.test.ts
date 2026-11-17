// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { proteinPerKgThatFits, proteinShareBounds } from './nutrition.js';

describe("the room for protein in somebody's own split", () => {
  it.each([
    // Fat at 30 %: protein's own limits, carbohydrate never in the way.
    [0.3, 0.1, 0.45],
    // Fat at 15 %: carbohydrate may not take more than 70 %, so protein has at least 15 %.
    [0.15, 0.15, 0.45],
    // Fat at 75 %: carbohydrate needs its 5 %, so protein has at most 20 %.
    [0.75, 0.1, 0.2],
  ])('with fat at %s of the day lies from %s to %s', (fat, least, most) => {
    const bounds = proteinShareBounds(fat);

    expect(bounds.least).toBeCloseTo(least, 9);
    expect(bounds.most).toBeCloseTo(most, 9);
  });
});

describe('the protein per kilogram that fits a target and a weight', () => {
  it('is the tenths inside the limits of the split and of protein per kilogram', () => {
    // 45 % of 1800 kcal is 202.5 g, 2.53 g for each of 80 kg; a tenth of it is 0.56 g, under the least a profile sets.
    expect(proteinPerKgThatFits(0.3, 1800, 80)).toEqual({ from: 0.8, to: 2.5 });
  });

  it('takes a bound that is a tenth but for the error of floating point as that tenth', () => {
    // Fat at 15 % leaves protein 15 % of 2000 kcal at least: 75 g, exactly 1 g for each of 75 kg.
    expect(proteinPerKgThatFits(0.15, 2000, 75)).toEqual({ from: 1, to: 3 });
  });

  it('is none where no tenth fits', () => {
    // Fat at 75 % leaves protein 20 % of 1200 kcal at most: 60 g, 0.4 g for each of 150 kg.
    expect(proteinPerKgThatFits(0.75, 1200, 150)).toBeNull();
  });
});
