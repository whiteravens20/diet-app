// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { pickIndex, violations, type Candidate, type Restrictions } from './eligibility.js';

const restrictions = (overrides: Partial<Restrictions> = {}): Restrictions => ({
  userId: 'me',
  diet: 'balanced',
  allergens: [],
  excludedIngredientIds: [],
  avoidedRecipeIds: [],
  ...overrides,
});

const recipe = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 'recipe',
  mealTypes: ['lunch', 'dinner'],
  dietTags: ['vegetarian'],
  allergens: ['dairy'],
  createdByUserId: null,
  deletedAt: null,
  retiredAt: null,
  ingredients: [{ ingredientId: 'cheese' }, { ingredientId: 'rice' }],
  ...overrides,
});

describe('violations', () => {
  it('finds none for a shared recipe that suits the meal and the profile', () => {
    expect(violations(recipe(), restrictions(), 'lunch')).toEqual([]);
  });

  it.each<[string, Partial<Candidate>, Partial<Restrictions>, string[]]>([
    ['another meal', {}, {}, ['wrong_meal']],
    ['a diet it does not qualify for', {}, { diet: 'vegan' }, ['off_diet']],
    ['an allergen of the profile', {}, { allergens: ['dairy', 'soy'] }, ['allergen']],
    ['an ingredient the profile skips', {}, { excludedIngredientIds: ['rice'] }, ['excluded_ingredient']],
    ['a mark to avoid it', {}, { avoidedRecipeIds: ['recipe'] }, ['avoided']],
    ["another user's ownership", { createdByUserId: 'someone-else' }, {}, ['not_available']],
    ['having been deleted', { createdByUserId: 'me', deletedAt: new Date() }, {}, ['not_available']],
    ['having been retired', { retiredAt: new Date() }, {}, ['not_available']],
  ])('names %s', (name, recipeChange, restrictionChange, expected) => {
    const meal = name === 'another meal' ? 'breakfast' : 'lunch';
    expect(violations(recipe(recipeChange), restrictions(restrictionChange), meal)).toEqual(expected);
  });

  it('names every reason at once', () => {
    const found = violations(
      recipe({ createdByUserId: 'someone-else' }),
      restrictions({ diet: 'keto', allergens: ['dairy'], excludedIngredientIds: ['cheese'], avoidedRecipeIds: ['recipe'] }),
      'snack',
    );
    expect(found).toEqual(['not_available', 'wrong_meal', 'off_diet', 'allergen', 'excluded_ingredient', 'avoided']);
  });

  it("admits the user's own recipe", () => {
    expect(violations(recipe({ createdByUserId: 'me' }), restrictions(), 'lunch')).toEqual([]);
  });

  it.each(['balanced', 'high_protein', 'custom'] as const)('holds no recipe to a tag on a %s plan', (diet) => {
    expect(violations(recipe({ dietTags: [] }), restrictions({ diet }), 'lunch')).toEqual([]);
  });

  describe('when the user asked for this very recipe', () => {
    const waived = { dietAndMeal: true };

    it('lets the diet and the meal go', () => {
      expect(violations(recipe(), restrictions({ diet: 'vegan' }), 'breakfast', waived)).toEqual([]);
    });

    it('still holds to allergens, skipped ingredients, the avoid mark and availability', () => {
      const found = violations(
        recipe({ retiredAt: new Date() }),
        restrictions({ allergens: ['dairy'], excludedIngredientIds: ['rice'], avoidedRecipeIds: ['recipe'] }),
        'breakfast',
        waived,
      );
      expect(found).toEqual(['not_available', 'allergen', 'excluded_ingredient', 'avoided']);
    });
  });
});

describe('pickIndex', () => {
  it('gives the same position for the same key and stays inside the list', () => {
    for (const size of [1, 2, 7, 25]) {
      const position = pickIndex('meal-123:4', size);
      expect(position).toBe(pickIndex('meal-123:4', size));
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThan(size);
    }
  });

  it('spreads keys evenly over the positions, odd ones included', () => {
    const size = 8;
    const hits = new Array<number>(size).fill(0);
    const keys = 8_000;
    for (let i = 0; i < keys; i += 1) {
      hits[pickIndex(`3f2c9a1e-0b7d-4c55-9e21-7a6f0d4c8b1${i % 10}:${i}`, size)]! += 1;
    }
    // Each position expects a thousand. The rounding fault this replaces put
    // nearly all of them on even positions.
    for (const count of hits) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1_150);
    }
  });
});
