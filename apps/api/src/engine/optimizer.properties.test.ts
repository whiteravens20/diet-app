// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** What every plan the optimiser makes has to hold, whatever the seed. */
import type { MealType } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import {
  reuseScore,
  seededJitter,
  type OptimizerRecipe,
} from './optimizer.js';

const dish = (id: string, mealTypes: MealType[], kcal: number, over: Partial<OptimizerRecipe> = {}): OptimizerRecipe => ({
  id,
  mealTypes,
  dietTags: [],
  caloriesPerServing: kcal,
  proteinPerServing: 20,
  fatPerServing: 15,
  carbsPerServing: 40,
  ingredientIds: [`${id}-a`, `${id}-b`],
  difficulty: 'easy',
  isFavorite: false,
  totalMinutes: 20,
  ...over,
});

/** A catalogue as a small instance has one: a handful of dishes for each meal, some for two meals. */
const CATALOGUE: OptimizerRecipe[] = [
  ...[320, 380, 410, 450, 500, 540].map((kcal, i) => dish(`breakfast-${i}`, ['breakfast'], kcal)),
  ...[180, 210, 240, 280].map((kcal, i) => dish(`second-${i}`, ['second_breakfast', 'snack'], kcal)),
  ...[480, 520, 560, 610, 650, 700].map((kcal, i) => dish(`main-${i}`, ['lunch', 'dinner'], kcal)),
  ...[430, 470, 590].map((kcal, i) => dish(`lunch-${i}`, ['lunch'], kcal)),
  ...[440, 500, 620].map((kcal, i) => dish(`dinner-${i}`, ['dinner'], kcal)),
  ...[120, 150, 190, 230].map((kcal, i) => dish(`snack-${i}`, ['snack'], kcal)),
];

describe('the seed of a plan', () => {
  it('gives each recipe an offset under 0.12 that is the same for the same seed', () => {
    for (const seed of [0, 1, 7, 2 ** 31 - 1, 2 ** 32 - 1, 123456789]) {
      const offset = seededJitter('main-3', seed);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(0.12);
      expect(seededJitter('main-3', seed)).toBe(offset);
    }
  });

  it('spreads the offsets of the recipes, and changes them all with the seed', () => {
    const ids = CATALOGUE.map((r) => r.id);
    const offsets = (seed: number) => ids.map((id) => seededJitter(id, seed));
    // Not all alike for one seed, and not in the same order for the next.
    expect(new Set(offsets(1).map((o) => o.toFixed(4))).size).toBeGreaterThan(ids.length * 0.8);
    const order = (seed: number) => [...ids].sort((a, b) => seededJitter(a, seed) - seededJitter(b, seed)).join(',');
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(order)).size).toBe(8);
    // Seeds that differ only in their high bits give different offsets: none of the seed is lost.
    expect(seededJitter('main-3', 1)).not.toBe(seededJitter('main-3', 1 + 2 ** 31));
  });
});

describe('the reuse of ingredients in a plan', () => {
  const eggs = dish('eggs', ['breakfast'], 400, { ingredientIds: ['egg', 'butter'] });
  const omelette = dish('omelette', ['lunch'], 600, { ingredientIds: ['egg', 'cheese'] });
  const at = (dayIndex: number, recipeId: string) => ({ dayIndex, slot: 'breakfast' as const, recipeId, servings: 1 });

  it('is the share of ingredients that more than one recipe uses', () => {
    expect(reuseScore([at(0, 'eggs'), at(0, 'omelette')], [eggs, omelette])).toBeCloseTo(1 / 3, 6);
  });

  it('does not count a recipe that is eaten again as reuse', () => {
    expect(reuseScore([at(0, 'eggs'), at(1, 'eggs'), at(2, 'eggs')], [eggs, omelette])).toBe(0);
  });
});
