// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { givenAsCookedMeat } from './raw-meat.js';

const chicken = { slug: 'chicken-breast', category: 'meat', packSize: 500, proteinPer100: 22.5 };

describe('meat and fish that are sold in a pack', () => {
  it('are given as the raw food a recipe weighs and a list buys', () => {
    expect(givenAsCookedMeat([chicken, { slug: 'cod-fillet', category: 'fish', packSize: 250, proteinPer100: 18 }, { slug: 'bacon', category: 'meat', packSize: 150, proteinPer100: 13.7 }])).toEqual([]);
  });

  it('are named when their figures are those of the cooked food', () => {
    // Roasted chicken breast and cooked shrimp, as the database of foods has them.
    expect(givenAsCookedMeat([chicken, { ...chicken, slug: 'roasted-chicken', proteinPer100: 31 }, { slug: 'shrimp', category: 'fish', packSize: 250, proteinPer100: 24 }, { slug: 'cooked-shrimp', category: 'fish', packSize: 250, proteinPer100: 26 }])).toEqual([
      'roasted-chicken',
      'cooked-shrimp',
    ]);
  });

  it('are not what is bought ready, what an import brought without a pack, or another kind of food', () => {
    expect(
      givenAsCookedMeat([
        { slug: 'canned-tuna', category: 'fish', packSize: 145, proteinPer100: 26 },
        { slug: 'chicken-broiler-or-fryers-breast-cooked-braised', category: 'meat', proteinPer100: 32.1 },
        { slug: 'pumpkin-seeds', category: 'nuts_seeds', packSize: 200, proteinPer100: 30.2 },
      ]),
    ).toEqual([]);
  });

  it('are raw in the catalogue this repository ships', () => {
    const curated = JSON.parse(readFileSync(join(__dirname, '../../../../../data/ingredients.json'), 'utf8')) as Parameters<typeof givenAsCookedMeat>[0];
    expect(givenAsCookedMeat(curated)).toEqual([]);
  });
});
