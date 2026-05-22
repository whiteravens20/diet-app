import { describe, expect, it } from 'vitest';
import {
  OptimizerError,
  fitServings,
  optimisePlan,
  slotBudgets,
  type OptimizerInput,
  type OptimizerRecipe,
} from './optimizer.js';

function recipe(id: string, slots: OptimizerRecipe['mealTypes'], cals: number): OptimizerRecipe {
  return {
    id,
    mealTypes: slots,
    dietTags: ['balanced'],
    caloriesPerServing: cals,
    proteinPerServing: 20,
    fatPerServing: 15,
    carbsPerServing: 40,
    ingredientIds: [`${id}-a`, `${id}-b`, 'shared'],
    difficulty: 'easy',
    isFavorite: false,
  };
}

const baseInput: OptimizerInput = {
  recipes: [
    recipe('b1', ['breakfast'], 450),
    recipe('b2', ['breakfast'], 500),
    recipe('l1', ['lunch'], 650),
    recipe('l2', ['lunch'], 700),
    recipe('d1', ['dinner'], 600),
    recipe('d2', ['dinner'], 550),
  ],
  days: 3,
  mealSlots: ['breakfast', 'lunch', 'dinner'],
  dailyCalorieTarget: 2000,
  targetMacros: { protein: 120, fat: 60, carbs: 220 },
  dietType: 'balanced',
  mealPrepFriendly: false,
  seed: 1,
};

describe('slotBudgets', () => {
  it('produces per-slot budgets that sum to the daily target', () => {
    const budgets = slotBudgets(['breakfast', 'lunch', 'dinner'], 2000);
    const sum = [...budgets.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(2000);
  });
});

describe('fitServings', () => {
  it('quantises to quarter servings within bounds', () => {
    expect(fitServings(500, 650)).toBe(1.25);
    expect(fitServings(500, 100)).toBe(0.5); // clamped to min
    expect(fitServings(100, 2000)).toBe(3); // clamped to max
  });
});

describe('optimisePlan', () => {
  it('fills every slot for every day', () => {
    const result = optimisePlan(baseInput);
    expect(result.assignments).toHaveLength(3 * 3);
    for (let day = 0; day < 3; day++) {
      const slots = result.assignments.filter((a) => a.dayIndex === day).map((a) => a.slot);
      expect(slots.sort()).toEqual(['breakfast', 'dinner', 'lunch']);
    }
  });

  it('is deterministic — same input yields the same plan', () => {
    expect(optimisePlan(baseInput)).toEqual(optimisePlan(baseInput));
  });

  it('can vary the plan via the seed (regenerate)', () => {
    const base = optimisePlan({ ...baseInput, seed: 1 }).assignments
      .map((x) => x.recipeId)
      .join();
    const differs = [2, 3, 4, 5, 6, 7, 8, 9, 10].some(
      (seed) =>
        optimisePlan({ ...baseInput, seed }).assignments.map((x) => x.recipeId).join() !== base,
    );
    expect(differs).toBe(true);
  });

  it('reports an ingredient-reuse score in [0, 1]', () => {
    const { ingredientReuseScore } = optimisePlan(baseInput);
    expect(ingredientReuseScore).toBeGreaterThan(0); // every recipe shares "shared"
    expect(ingredientReuseScore).toBeLessThanOrEqual(1);
  });

  it('throws when a slot has no eligible recipe', () => {
    expect(() => optimisePlan({ ...baseInput, mealSlots: ['snack'] })).toThrow(OptimizerError);
  });
});
