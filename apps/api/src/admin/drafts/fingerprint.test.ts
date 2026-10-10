// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { computeFingerprint, type FingerprintInput } from './fingerprint.js';

const recipe = (overrides: Partial<FingerprintInput> = {}): FingerprintInput => ({
  ingredients: [
    { slug: 'chicken-breast', quantity: 150, unit: 'g' },
    { slug: 'white-rice', quantity: 80, unit: 'g' },
    { slug: 'olive-oil', quantity: 10, unit: 'ml' },
  ],
  mealTypes: ['lunch', 'dinner'],
  servings: 1,
  ...overrides,
});

describe('computeFingerprint', () => {
  it('has a fixed value for a fixed recipe', () => {
    // Pinned: stored fingerprints stop matching the moment the canonical form changes.
    expect(computeFingerprint(recipe())).toBe('47a48136f83b706a9ff3d14369a1a268c4d83318d646126f181445b5ab588fa5');
  });

  it('does not depend on the order of the lines or of the meals', () => {
    const shuffled = recipe({
      ingredients: [...recipe().ingredients].reverse(),
      mealTypes: ['dinner', 'lunch'],
    });
    expect(computeFingerprint(shuffled)).toBe(computeFingerprint(recipe()));
  });

  it('counts an ingredient listed twice as the sum, in whichever order', () => {
    const once = recipe({
      ingredients: [
        { slug: 'olive-oil', quantity: 15, unit: 'ml' },
        { slug: 'tomato', quantity: 200, unit: 'g' },
      ],
    });
    const twice = recipe({
      ingredients: [
        { slug: 'olive-oil', quantity: 5, unit: 'ml' },
        { slug: 'tomato', quantity: 200, unit: 'g' },
        { slug: 'olive-oil', quantity: 10, unit: 'ml' },
      ],
    });
    const twiceReversed = recipe({ ingredients: [...twice.ingredients].reverse() });
    expect(computeFingerprint(twice)).toBe(computeFingerprint(once));
    expect(computeFingerprint(twiceReversed)).toBe(computeFingerprint(once));
  });

  it('ignores a meal named twice', () => {
    expect(computeFingerprint(recipe({ mealTypes: ['lunch', 'dinner', 'lunch'] }))).toBe(computeFingerprint(recipe()));
  });

  it('treats the noise of floating-point arithmetic as nothing', () => {
    const noisy = recipe({
      ingredients: recipe().ingredients.map((line) => ({ ...line, quantity: line.quantity + 0.00000001 })),
    });
    expect(computeFingerprint(noisy)).toBe(computeFingerprint(recipe()));
  });

  it.each<[string, Partial<FingerprintInput>]>([
    ['another quantity', { ingredients: [{ slug: 'chicken-breast', quantity: 150.1, unit: 'g' }, ...recipe().ingredients.slice(1)] }],
    ['another ingredient', { ingredients: [{ slug: 'firm-tofu', quantity: 150, unit: 'g' }, ...recipe().ingredients.slice(1)] }],
    ['another unit for the same number', { ingredients: [...recipe().ingredients.slice(0, 2), { slug: 'olive-oil', quantity: 10, unit: 'g' }] }],
    ['one line fewer', { ingredients: recipe().ingredients.slice(0, 2) }],
    ['another meal', { mealTypes: ['lunch'] }],
    ['other servings', { servings: 2 }],
  ])('tells apart a recipe with %s', (_name, change) => {
    expect(computeFingerprint(recipe(change))).not.toBe(computeFingerprint(recipe()));
  });

  it('keeps apart the same ingredient in two units', () => {
    const mixed = recipe({
      ingredients: [
        { slug: 'olive-oil', quantity: 10, unit: 'ml' },
        { slug: 'olive-oil', quantity: 10, unit: 'g' },
      ],
    });
    const merged = recipe({ ingredients: [{ slug: 'olive-oil', quantity: 20, unit: 'ml' }] });
    expect(computeFingerprint(mixed)).not.toBe(computeFingerprint(merged));
  });

  it('is 64 hex characters', () => {
    expect(computeFingerprint(recipe())).toMatch(/^[0-9a-f]{64}$/);
  });
});
