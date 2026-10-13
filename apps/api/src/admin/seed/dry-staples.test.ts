// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { givenAsCooked } from './dry-staples.js';

const rice = { slug: 'white-rice', category: 'grains', packSize: 1000, caloriesPer100: 365 };

describe('a grain or a pulse that keeps in its pack', () => {
  it('is given as the dry food a recipe weighs and a list buys', () => {
    expect(givenAsCooked([rice, { slug: 'red-lentils', category: 'legumes', packSize: 500, caloriesPer100: 358 }])).toEqual([]);
  });

  it('is named when its figures are those of the cooked food', () => {
    expect(givenAsCooked([rice, { ...rice, slug: 'cooked-rice', caloriesPer100: 130 }, { slug: 'couscous', category: 'grains', packSize: 500, caloriesPer100: 112 }])).toEqual(['cooked-rice', 'couscous']);
  });

  it('is not what is canned or fresh, what is sold loose, what is frozen, or another kind of food', () => {
    expect(
      givenAsCooked([
        { slug: 'chickpeas', category: 'legumes', packSize: 400, perishable: true, caloriesPer100: 164 },
        { slug: 'whole-grain-bread', category: 'grains', packSize: 500, perishable: true, caloriesPer100: 247 },
        { slug: 'sweetcorn', category: 'grains', caloriesPer100: 86 },
        { slug: 'edamame', category: 'legumes', packSize: 400, caloriesPer100: 122 },
        { slug: 'broccoli', category: 'vegetables', packSize: 500, caloriesPer100: 34 },
      ]),
    ).toEqual([]);
  });
});
