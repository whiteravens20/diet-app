// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { freshOf, type IngredientRow } from './shopping-lists.service.js';

/** Chicken in packs of 500 g that keep two days once opened. */
const chicken = {
  id: 'chicken',
  name: 'Chicken breast',
  category: 'meat',
  canonicalUnit: 'g',
  displayUnit: null,
  gramsPerPiece: null,
  density: null,
  packSize: 500,
  keepDays: 2,
  perishable: true,
  tags: [],
  translations: [],
} as unknown as IngredientRow;

const monday = new Date('2026-01-05');
const week = { fromDate: monday, toDate: new Date('2026-01-11') };
const line = (day: number, quantity: number, ingredientId = 'chicken') => ({
  ingredientId,
  quantity,
  unit: 'g' as const,
  recipeServings: 1,
  plannedServings: 1,
  date: new Date(monday.getTime() + day * 86_400_000),
});
const row = {
  ingredientId: 'chicken',
  unit: 'g' as const,
  totalQuantity: 300,
  alreadyHaveQuantity: 0,
};
const lines = [line(0, 150), line(5, 150), line(5, 80, 'rice')];

describe('the packs of a row of fresh meat or fish', () => {
  it('are counted as the plan counts them, and say which to buy later and from which day', () => {
    expect(freshOf(row, chicken, lines, week)).toEqual({
      count: 2,
      later: [{ packs: 1, from: '2026-01-09' }],
    });
  });

  it('scale with the servings planned against the recipe', () => {
    const doubled = [{ ...line(0, 150), plannedServings: 4, recipeServings: 2 }];
    expect(freshOf({ ...row, totalQuantity: 300 }, chicken, doubled, week)).toEqual({
      count: 1,
      later: [],
    });
  });

  it('are none for what keeps closed longer than opened: tinned, smoked or cured, dairy, and what is not perishable', () => {
    for (const other of [
      { ...chicken, tags: ['cured'] },
      { ...chicken, tags: ['pantry', 'protein'] },
      { ...chicken, category: 'dairy' },
      { ...chicken, perishable: false },
      { ...chicken, packSize: null },
    ] as IngredientRow[])
      expect(freshOf(row, other, lines, week)).toBeNull();
    expect(freshOf(row, undefined, lines, week)).toBeNull();
  });

  it('are none when what is at home covers every need', () => {
    expect(freshOf({ ...row, alreadyHaveQuantity: 300 }, chicken, lines, week)).toBeNull();
  });
});
