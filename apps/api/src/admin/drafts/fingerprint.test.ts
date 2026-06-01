import { describe, expect, it } from 'vitest';
import type { ConvertibleIngredient } from '../../engine/units.js';
import {
  computeFingerprint,
  FingerprintError,
  type FingerprintIngredientLookup,
} from './fingerprint.js';

const oliveOil: ConvertibleIngredient = {
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: 0.92,
};
const chicken: ConvertibleIngredient = {
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
};
const egg: ConvertibleIngredient = {
  canonicalUnit: 'g',
  gramsPerPiece: 55,
  density: null,
};

const lookup: FingerprintIngredientLookup = new Map([
  ['olive-oil', oliveOil],
  ['chicken-breast', chicken],
  ['egg', egg],
]);

describe('computeFingerprint', () => {
  it('is order-independent on ingredient lines', () => {
    const a = computeFingerprint(
      {
        ingredients: [
          { slug: 'chicken-breast', quantity: 200, unit: 'g' },
          { slug: 'olive-oil', quantity: 10, unit: 'g' },
        ],
        mealTypes: ['dinner'],
        dietTags: ['balanced'],
        servings: 2,
      },
      lookup,
    );
    const b = computeFingerprint(
      {
        ingredients: [
          { slug: 'olive-oil', quantity: 10, unit: 'g' },
          { slug: 'chicken-breast', quantity: 200, unit: 'g' },
        ],
        mealTypes: ['dinner'],
        dietTags: ['balanced'],
        servings: 2,
      },
      lookup,
    );
    expect(a).toBe(b);
  });

  it('is order-independent on mealTypes and dietTags', () => {
    const a = computeFingerprint(
      {
        ingredients: [{ slug: 'chicken-breast', quantity: 100, unit: 'g' }],
        mealTypes: ['lunch', 'dinner'],
        dietTags: ['balanced', 'high_protein'],
        servings: 1,
      },
      lookup,
    );
    const b = computeFingerprint(
      {
        ingredients: [{ slug: 'chicken-breast', quantity: 100, unit: 'g' }],
        mealTypes: ['dinner', 'lunch'],
        dietTags: ['high_protein', 'balanced'],
        servings: 1,
      },
      lookup,
    );
    expect(a).toBe(b);
  });

  it('canonicalises units so equivalent quantities hash identically', () => {
    // 10 g of olive oil ≡ 10 / 0.92 ml ≈ 10.87 ml. After canonicalising to g,
    // both inputs round to 10.0 and hash identically.
    const inGrams = computeFingerprint(
      {
        ingredients: [{ slug: 'olive-oil', quantity: 10, unit: 'g' }],
        mealTypes: ['dinner'],
        dietTags: ['balanced'],
        servings: 1,
      },
      lookup,
    );
    const inMl = computeFingerprint(
      {
        ingredients: [
          { slug: 'olive-oil', quantity: 10 / 0.92, unit: 'ml' },
        ],
        mealTypes: ['dinner'],
        dietTags: ['balanced'],
        servings: 1,
      },
      lookup,
    );
    expect(inGrams).toBe(inMl);
  });

  it('canonicalises piece → grams for piece-quantified ingredients', () => {
    // 3 eggs at 55g/piece ≡ 165g — both representations hash identically
    // because the helper converts to canonical (g) before hashing.
    const inPieces = computeFingerprint(
      {
        ingredients: [{ slug: 'egg', quantity: 3, unit: 'piece' }],
        mealTypes: ['breakfast'],
        dietTags: ['balanced'],
        servings: 1,
      },
      lookup,
    );
    const inGrams = computeFingerprint(
      {
        ingredients: [{ slug: 'egg', quantity: 165, unit: 'g' }],
        mealTypes: ['breakfast'],
        dietTags: ['balanced'],
        servings: 1,
      },
      lookup,
    );
    expect(inPieces).toBe(inGrams);
  });

  it('treats trivial float jitter as identical', () => {
    const a = computeFingerprint(
      {
        ingredients: [{ slug: 'chicken-breast', quantity: 200.0, unit: 'g' }],
        mealTypes: ['dinner'],
        dietTags: ['balanced'],
        servings: 1,
      },
      lookup,
    );
    const b = computeFingerprint(
      {
        ingredients: [
          { slug: 'chicken-breast', quantity: 200.00000001, unit: 'g' },
        ],
        mealTypes: ['dinner'],
        dietTags: ['balanced'],
        servings: 1,
      },
      lookup,
    );
    expect(a).toBe(b);
  });

  it('distinguishes recipes with different ingredient sets', () => {
    const a = computeFingerprint(
      {
        ingredients: [{ slug: 'chicken-breast', quantity: 200, unit: 'g' }],
        mealTypes: ['dinner'],
        dietTags: ['balanced'],
        servings: 1,
      },
      lookup,
    );
    const b = computeFingerprint(
      {
        ingredients: [{ slug: 'olive-oil', quantity: 200, unit: 'g' }],
        mealTypes: ['dinner'],
        dietTags: ['balanced'],
        servings: 1,
      },
      lookup,
    );
    expect(a).not.toBe(b);
  });

  it('distinguishes recipes with different servings', () => {
    const base = {
      ingredients: [
        { slug: 'chicken-breast' as const, quantity: 200, unit: 'g' as const },
      ],
      mealTypes: ['dinner'],
      dietTags: ['balanced'],
    };
    const a = computeFingerprint({ ...base, servings: 1 }, lookup);
    const b = computeFingerprint({ ...base, servings: 2 }, lookup);
    expect(a).not.toBe(b);
  });

  it('throws when the lookup is missing an ingredient slug', () => {
    expect(() =>
      computeFingerprint(
        {
          ingredients: [{ slug: 'unknown-thing', quantity: 100, unit: 'g' }],
          mealTypes: ['dinner'],
          dietTags: ['balanced'],
          servings: 1,
        },
        lookup,
      ),
    ).toThrow(FingerprintError);
  });
});
