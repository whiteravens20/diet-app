// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { UnitConversionError, convertUnit, nutritionFor, toCanonical } from './units.js';

const milk = { canonicalUnit: 'ml' as const, gramsPerPiece: null, density: 1.03 };
const egg = { canonicalUnit: 'g' as const, gramsPerPiece: 55, density: null };
const rice = { canonicalUnit: 'g' as const, gramsPerPiece: null, density: null };
// Ingredients whose canonical unit is `piece` exercise the g/ml → piece branch.
const eggPiece = { canonicalUnit: 'piece' as const, gramsPerPiece: 55, density: null };
const scoop = { canonicalUnit: 'piece' as const, gramsPerPiece: 30, density: 1 };
const bottledMilk = { canonicalUnit: 'ml' as const, gramsPerPiece: 50, density: 1 };
const piecelessTarget = { canonicalUnit: 'piece' as const, gramsPerPiece: null, density: null };
const yogurt = { canonicalUnit: 'g' as const, gramsPerPiece: null, density: 1.04 };

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

  it('converts ml to grams using density', () => {
    expect(toCanonical(100, 'ml', yogurt)).toBeCloseTo(104); // 100 ml × 1.04 g/ml
  });

  it('converts grams to pieces using gramsPerPiece', () => {
    expect(toCanonical(110, 'g', eggPiece)).toBe(2); // 110 g / 55 g per piece
  });

  it('converts ml to pieces via density then gramsPerPiece', () => {
    expect(toCanonical(60, 'ml', scoop)).toBe(2); // 60 ml × 1 g/ml = 60 g / 30 g per piece
  });

  it('converts pieces to ml via gramsPerPiece then density', () => {
    expect(toCanonical(1, 'piece', bottledMilk)).toBe(50); // 1 × 50 g / 1 g per ml
  });

  it('throws when gramsPerPiece is missing converting TO piece', () => {
    expect(() => toCanonical(100, 'g', piecelessTarget)).toThrow(UnitConversionError);
  });
});

describe('nutritionFor', () => {
  it('scales per-100 values by quantity', () => {
    const n = nutritionFor(250, { calories: 130, protein: 2.7, fat: 0.3, carbs: 28 });
    expect(n.calories).toBeCloseTo(325); // 130 * 2.5
    expect(n.carbs).toBeCloseTo(70);
  });
});

describe('a factor that is not a positive number', () => {
  const zeroDensity = { canonicalUnit: 'ml' as const, gramsPerPiece: 0, density: 0 };

  it('is refused like a missing one, instead of making nothing or infinity', () => {
    expect(() => toCanonical(100, 'g', zeroDensity)).toThrow(UnitConversionError);
    expect(() => toCanonical(3, 'piece', zeroDensity)).toThrow(UnitConversionError);
    expect(() => toCanonical(100, 'ml', { canonicalUnit: 'piece', gramsPerPiece: -5, density: 1 })).toThrow(UnitConversionError);
  });
});

describe('convertUnit', () => {
  it('converts between any two units, not only into the canonical one', () => {
    expect(convertUnit(220, 'g', 'piece', egg)).toBe(4);
    expect(convertUnit(4, 'piece', 'g', egg)).toBe(220);
    expect(convertUnit(7, 'g', 'g', egg)).toBe(7);
  });

  it('refuses a conversion the ingredient has no factor for', () => {
    expect(() => convertUnit(100, 'g', 'ml', egg)).toThrow(UnitConversionError);
  });
});
