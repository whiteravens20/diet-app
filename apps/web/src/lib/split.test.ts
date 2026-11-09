// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { foodWeight, sharesOf, splitWhole } from './split';

describe('the shares of a dish', () => {
  it('come from the energy each portion is planned to hold', () => {
    const [monday, tuesday] = sharesOf([640, 560]);
    expect(monday).toBeCloseTo(640 / 1200);
    expect(tuesday).toBeCloseTo(560 / 1200);
  });

  it('are equal where no portion says what it holds', () => {
    expect(sharesOf([null, null, null])).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(sharesOf([0, 0])).toEqual([0.5, 0.5]);
  });

  it('give a portion of no known energy nothing beside one that has it', () => {
    expect(sharesOf([500, null])).toEqual([1, 0]);
  });
});

describe('a dish split into whole grams or pieces', () => {
  it('gives each its part and the last what is left, adding up to what was weighed', () => {
    expect(splitWhole(1250, sharesOf([640, 560]))).toEqual([667, 583]);
  });

  it('keeps every portion within one of its exact part and the sum exact, whatever the shares', () => {
    for (const [whole, kcal] of [
      [1000, [1, 1, 1]],
      [7, [3, 2, 2]],
      [3, [700, 450]],
      [1, [600, 400]],
      [2345, [512, 498, 731, 260]],
    ] as const) {
      const shares = sharesOf(kcal);
      const portions = splitWhole(whole, shares);
      expect(portions.reduce((sum, one) => sum + one, 0)).toBe(whole);
      portions.forEach((portion, index) => {
        expect(portion).toBeGreaterThanOrEqual(0);
        expect(Math.abs(portion - whole * shares[index]!)).toBeLessThanOrEqual(1);
      });
    }
  });

  it('splits three eggs between two portions as two and one', () => {
    expect(splitWhole(3, sharesOf([700, 450]))).toEqual([2, 1]);
  });

  it('counts a weight with a fraction as the whole grams the scale shows', () => {
    expect(splitWhole(1250.4, [0.5, 0.5])).toEqual([625, 625]);
  });
});

describe('the food alone', () => {
  it('is what the scale shows, or that less the empty pot', () => {
    expect(foodWeight(1250, null)).toBe(1250);
    expect(foodWeight(2660, 1410)).toBe(1250);
  });

  it('is nothing where the empty pot weighs as much as the full one or more', () => {
    expect(foodWeight(1410, 1410)).toBeNull();
    expect(foodWeight(1000, 1410)).toBeNull();
    expect(foodWeight(0, null)).toBeNull();
  });
});
