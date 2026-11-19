// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { portionsOf } from './portions.js';

describe('an amount split into portions for the freezer', () => {
  it('splits what is weighed or measured into whole grams or millilitres as evenly as they go, the larger parts first', () => {
    expect(portionsOf(1000, 4)).toEqual([250, 250, 250, 250]);
    expect(portionsOf(500, 3)).toEqual([167, 167, 166]);
    expect(portionsOf(490, 3)).toEqual([164, 163, 163]);
    expect(portionsOf(750, 1)).toEqual([750]);
  });

  it('splits what is counted into whole pieces as evenly as they go, the larger parts first', () => {
    expect(portionsOf(6, 4)).toEqual([2, 2, 1, 1]);
    expect(portionsOf(6, 3)).toEqual([2, 2, 2]);
  });

  it('puts what is less than one of the unit with the last part', () => {
    expect(portionsOf(2.5, 2)).toEqual([1, 1.5]);
    expect(portionsOf(500.4, 3)).toEqual([167, 167, 166.4]);
    // The noise of converting units is no part of a gram.
    expect(portionsOf(499.9999999, 3)).toEqual([167, 167, 166]);
  });

  it('keeps every gram: the parts add up to the whole', () => {
    for (const [quantity, portions] of [
      [1000, 3],
      [737.25, 7],
      [10, 10],
      [12.5, 4],
    ] as const) {
      const parts = portionsOf(quantity, portions)!;
      expect(parts).toHaveLength(portions);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBeCloseTo(quantity, 6);
    }
  });

  it('splits nothing into parts of less than one of its unit', () => {
    expect(portionsOf(3, 4)).toBeNull();
    expect(portionsOf(5, 10)).toBeNull();
    expect(portionsOf(9.5, 10)).toBeNull();
  });
});
