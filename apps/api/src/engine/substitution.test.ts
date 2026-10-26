// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  MAX_SUBSTITUTE_RATIO,
  movedBy,
  substituteAmount,
  type EngineIngredient,
} from './substitution.js';

const ingredient = (
  id: string,
  per100: [kcal: number, protein: number, fat: number, carbs: number],
  over: Partial<EngineIngredient> = {},
): EngineIngredient => ({
  id,
  name: id,
  category: 'grains',
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  caloriesPer100: per100[0],
  proteinPer100: per100[1],
  fatPer100: per100[2],
  carbsPer100: per100[3],
  allergens: [],
  dietCompatibility: [],
  ...over,
});

const rice = ingredient('rice', [130, 2.7, 0.3, 28]);
const pasta = ingredient('pasta', [158, 5.8, 0.9, 31]);
const oil = ingredient('olive-oil', [813, 0, 92, 0], { canonicalUnit: 'ml', density: 0.91 });
const spinach = ingredient('spinach', [23, 2.9, 0.4, 3.6]);
const water = ingredient('water', [0, 0, 0, 0], { canonicalUnit: 'ml', density: 1 });
const salt = ingredient('salt', [0, 0, 0, 0]);

describe('how much of a substitute takes the place of an ingredient', () => {
  it('is as much as holds the same energy', () => {
    // 200 g of rice hold 260 kcal; so do 164.6 g of pasta.
    const { amount, sizing } = substituteAmount(rice, pasta, 200);

    expect(amount).toBeCloseTo(164.56, 1);
    expect(sizing).toBe('energy');
    expect((amount * pasta.caloriesPer100) / 100).toBeCloseTo(260);
  });

  it('is never more than three times what it replaces', () => {
    // 20 ml of oil hold the energy of 707 g of spinach, and weigh 18.2 g.
    const { amount, sizing } = substituteAmount(oil, spinach, 20);

    expect(MAX_SUBSTITUTE_RATIO).toBe(3);
    expect(amount).toBeCloseTo(54.6);
    expect(sizing).toBe('capped');
    // Exactly three times is no cap.
    expect(
      substituteAmount(ingredient('a', [300, 0, 0, 0]), ingredient('b', [100, 0, 0, 0]), 50),
    ).toEqual({ amount: 150, sizing: 'energy' });
  });

  it('is the same amount where the ingredient that leaves holds no energy', () => {
    expect(substituteAmount(water, oil, 200)).toEqual({ amount: 200, sizing: 'mass' });
  });

  it('is the same amount where the substitute holds no energy', () => {
    expect(substituteAmount(oil, water, 20)).toEqual({ amount: 20, sizing: 'mass' });
  });

  it('takes the same amount of a liquid and of something weighed to be what weighs the same', () => {
    // 20 ml of oil weigh 18.2 g; 10 g of salt weigh what 10.99 ml of oil do.
    expect(substituteAmount(oil, salt, 20).amount).toBeCloseTo(18.2);
    expect(substituteAmount(salt, oil, 10).amount).toBeCloseTo(10.99, 2);
    // Energy is counted per hundred of each one's own unit, so nothing is converted to match it.
    expect(substituteAmount(oil, ingredient('butter', [717, 0.9, 81, 0.1]), 20)).toEqual({
      amount: (20 * 813) / 717,
      sizing: 'energy',
    });
  });

  it('takes a millilitre for a gram where the catalogue does not say what a liquid weighs', () => {
    const stock = ingredient('stock', [0, 0, 0, 0], { canonicalUnit: 'ml' });

    expect(substituteAmount(stock, salt, 250)).toEqual({ amount: 250, sizing: 'mass' });
    expect(substituteAmount(salt, stock, 5)).toEqual({ amount: 5, sizing: 'mass' });
  });
});

describe('what of a serving a substitution moves by more than a tenth', () => {
  const serving = { calories: 600, protein: 40, fat: 20, carbs: 60 };

  it('is nothing inside a tenth, either way', () => {
    expect(movedBy(serving, { calories: 655, protein: 44, fat: 18, carbs: 66 })).toEqual([]);
    expect(movedBy(serving, serving)).toEqual([]);
  });

  it('names energy, protein, fat and carbohydrate, each on its own', () => {
    expect(movedBy(serving, { ...serving, calories: 661 })).toEqual(['calories']);
    expect(movedBy(serving, { ...serving, protein: 35 })).toEqual(['protein']);
    expect(movedBy(serving, { calories: 600, protein: 47, fat: 13, carbs: 136 })).toEqual([
      'protein',
      'fat',
      'carbs',
    ]);
  });

  it('does not take a gram or two for a move, however large a share of very little it is', () => {
    // From one gram of carbohydrate to three: twice as much again, and nothing anybody would notice.
    expect(
      movedBy(
        { calories: 400, protein: 30, fat: 30, carbs: 1 },
        { calories: 405, protein: 30, fat: 30, carbs: 3 },
      ),
    ).toEqual([]);
    expect(
      movedBy(
        { calories: 400, protein: 30, fat: 30, carbs: 1 },
        { calories: 405, protein: 30, fat: 30, carbs: 4 },
      ),
    ).toEqual(['carbs']);
    // Ten kilocalories of a serving of fifty.
    expect(
      movedBy(
        { calories: 50, protein: 1, fat: 1, carbs: 9 },
        { calories: 60, protein: 1, fat: 1, carbs: 9 },
      ),
    ).toEqual([]);
  });
});
