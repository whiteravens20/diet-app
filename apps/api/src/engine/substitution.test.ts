import { describe, expect, it } from 'vitest';
import { constraintViolations, substituteIngredient, type EngineIngredient } from './substitution.js';

const rice: EngineIngredient = {
  id: 'rice',
  name: 'White rice',
  category: 'grains',
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  caloriesPer100: 130,
  proteinPer100: 2.7,
  fatPer100: 0.3,
  carbsPer100: 28,
  allergens: [],
  dietCompatibility: ['balanced', 'vegan', 'vegetarian'],
};

const pasta: EngineIngredient = {
  ...rice,
  id: 'pasta',
  name: 'Pasta',
  caloriesPer100: 158,
  proteinPer100: 5.8,
  fatPer100: 0.9,
  carbsPer100: 31,
  allergens: ['gluten'],
  dietCompatibility: ['balanced', 'vegetarian'],
};

const noConstraints = { dietType: 'balanced' as const, allergens: [], excludedIngredientIds: [] };

describe('substituteIngredient', () => {
  it('scales the replacement to preserve calories', () => {
    const r = substituteIngredient(rice, pasta, 200, 'g', noConstraints);
    // 200 g rice = 260 kcal → pasta qty = 260/158*100 ≈ 164.6 g
    expect(r.before.calories).toBe(260);
    expect(r.after.calories).toBeCloseTo(260, 0);
    expect(r.adjustedQuantity).toBeCloseTo(164.6, 0);
    expect(r.valid).toBe(true);
  });

  it('reports a macro delta', () => {
    const r = substituteIngredient(rice, pasta, 200, 'g', noConstraints);
    expect(r.macroDelta.protein).toBeGreaterThan(0); // pasta has more protein
  });

  it('rejects a swap that introduces an allergen', () => {
    const r = substituteIngredient(rice, pasta, 200, 'g', {
      ...noConstraints,
      allergens: ['gluten'],
    });
    expect(r.valid).toBe(false);
    expect(r.explanation).toMatch(/gluten/);
  });
});

describe('constraintViolations', () => {
  it('flags diet incompatibility', () => {
    expect(constraintViolations(pasta, { ...noConstraints, dietType: 'vegan' })).toContain(
      'not compatible with vegan diet',
    );
  });

  it('flags excluded ingredients', () => {
    expect(
      constraintViolations(rice, { ...noConstraints, excludedIngredientIds: ['rice'] }),
    ).toContain('ingredient is excluded');
  });
});
