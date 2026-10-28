// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { aSupply } from '@/testing/public-config';
import { supplyOf } from './catalogue';

const supply = aSupply();
supply.vegan['4'] = { level: 'thin', recipes: 1, fewerMeals: 3 };

describe('what the API says of the catalogue for a diet at a number of meals a day', () => {
  it('is what the API answered for the pair', () => {
    expect(supplyOf(supply, 'vegan', 4)).toEqual({ level: 'thin', recipes: 1, fewerMeals: 3 });
    expect(supplyOf(supply, 'vegan', 3)).toMatchObject({ level: 'enough' });
  });

  it('is not given before the configuration answered, or for a number of meals nobody can have', () => {
    expect(supplyOf(undefined, 'vegan', 3)).toBeNull();
    expect(supplyOf(supply, 'vegan', 6)).toBeNull();
    expect(supplyOf(supply, 'vegan', Number.NaN)).toBeNull();
  });
});
