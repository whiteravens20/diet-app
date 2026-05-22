import { describe, expect, it } from 'vitest';
import { UnitConversionError, nutritionFor, toCanonical } from './units.js';

const milk = { canonicalUnit: 'ml' as const, gramsPerPiece: null, density: 1.03 };
const egg = { canonicalUnit: 'g' as const, gramsPerPiece: 55, density: null };
const rice = { canonicalUnit: 'g' as const, gramsPerPiece: null, density: null };

describe('toCanonical', () => {
  it('is a no-op when the unit already matches', () => {
    expect(toCanonical(200, 'g', rice)).toBe(200);
  });

  it('converts pieces to grams', () => {
    expect(toCanonical(3, 'piece', egg)).toBe(165); // 3 * 55 g
  });

  it('converts grams to ml using density', () => {
    expect(toCanonical(103, 'g', milk)).toBeCloseTo(100); // 103 / 1.03
  });

  it('throws when density is missing for a g↔ml conversion', () => {
    expect(() => toCanonical(100, 'ml', rice)).toThrow(UnitConversionError);
  });

  it('throws when gramsPerPiece is missing for a piece conversion', () => {
    expect(() => toCanonical(2, 'piece', rice)).toThrow(UnitConversionError);
  });
});

describe('nutritionFor', () => {
  it('scales per-100 values by quantity', () => {
    const n = nutritionFor(250, { calories: 130, protein: 2.7, fat: 0.3, carbs: 28 });
    expect(n.calories).toBeCloseTo(325); // 130 * 2.5
    expect(n.carbs).toBeCloseTo(70);
  });
});
