// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { portionsOf } from './portions.js';

describe('an amount split into portions for the freezer', () => {
  it('splits what is weighed or measured into equal parts, what rounding leaves with the last', () => {
    expect(portionsOf(1000, 'g', 4)).toEqual([250, 250, 250, 250]);
    expect(portionsOf(1000, 'g', 3)).toEqual([333.333333, 333.333333, 333.333334]);
    expect(portionsOf(750, 'ml', 1)).toEqual([750]);
  });

  it('splits what is counted into whole pieces as evenly as they go, the larger parts first', () => {
    expect(portionsOf(6, 'piece', 4)).toEqual([2, 2, 1, 1]);
    expect(portionsOf(6, 'piece', 3)).toEqual([2, 2, 2]);
    expect(portionsOf(2.5, 'piece', 2)).toEqual([1, 1.5]);
  });

  it('splits nothing into parts of less than one of its unit', () => {
    expect(portionsOf(3, 'piece', 4)).toBeNull();
    expect(portionsOf(5, 'g', 10)).toBeNull();
  });
});
