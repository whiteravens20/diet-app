import { describe, expect, it } from 'vitest';
import {
  OptimizerError,
  fitServings,
  optimisePlan,
  recipeCoverage,
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

  /**
   * Reported failure mode: a 28-day plan would fill every breakfast slot with
   * the same recipe because the reuse score formed a positive-feedback loop.
   * The hard repetition cap must break that loop even when the candidate
   * pool is small.
   */
  it('honours maxConsecutiveDaysSameMeal and maxTimesPerWeekSameMeal on long plans', () => {
    // Three eligible recipes per slot: the cap is achievable. With only two
    // it isn't (3+3 < 7), and the optimiser correctly falls back to the
    // un-capped pool rather than throwing.
    const longInput: OptimizerInput = {
      ...baseInput,
      recipes: [
        ...baseInput.recipes,
        recipe('b3', ['breakfast'], 480),
        recipe('l3', ['lunch'], 680),
        recipe('d3', ['dinner'], 580),
      ],
      days: 28,
      maxConsecutiveDaysSameMeal: 2,
      maxTimesPerWeekSameMeal: 3,
    };
    const result = optimisePlan(longInput);

    // No three identical recipes in a row at any slot.
    for (const slot of longInput.mealSlots) {
      const ids = result.assignments
        .filter((a) => a.slot === slot)
        .sort((a, b) => a.dayIndex - b.dayIndex)
        .map((a) => a.recipeId);
      for (let i = 0; i + 2 < ids.length; i++) {
        expect(ids[i] === ids[i + 1] && ids[i] === ids[i + 2]).toBe(false);
      }
      // No recipe appears more than 3 times in any rolling 7-day window.
      for (let start = 0; start + 7 <= ids.length; start++) {
        const window = ids.slice(start, start + 7);
        const counts = new Map<string, number>();
        for (const id of window) counts.set(id, (counts.get(id) ?? 0) + 1);
        for (const c of counts.values()) expect(c).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('recipeCoverage', () => {
  it('returns 1.0 when every required ingredient is fully stocked', () => {
    const reqs = [
      { ingredientId: 'a', canonicalQuantity: 200 },
      { ingredientId: 'b', canonicalQuantity: 100 },
    ];
    const pantry = new Map([
      ['a', 500],
      ['b', 300],
    ]);
    expect(recipeCoverage(reqs, pantry)).toBe(1);
  });

  it('caps each ingredient at the required mass — extra stock does not double-count', () => {
    const reqs = [
      { ingredientId: 'a', canonicalQuantity: 100 },
      { ingredientId: 'b', canonicalQuantity: 100 },
    ];
    // Pantry has 1000 g of 'a' (only 100 g counts) and 0 of 'b' → coverage 0.5.
    const pantry = new Map([['a', 1000]]);
    expect(recipeCoverage(reqs, pantry)).toBe(0.5);
  });

  it('returns 0 when the pantry is empty', () => {
    const reqs = [{ ingredientId: 'a', canonicalQuantity: 100 }];
    expect(recipeCoverage(reqs, new Map())).toBe(0);
  });

  it('returns 0 for an empty requirement list (defensive)', () => {
    expect(recipeCoverage([], new Map([['a', 100]]))).toBe(0);
  });

  it('partially covers when a row is short', () => {
    const reqs = [
      { ingredientId: 'a', canonicalQuantity: 200 },
      { ingredientId: 'b', canonicalQuantity: 100 },
    ];
    // 100 + 100 = 200 covered of 300 required → 0.6666…
    const pantry = new Map([
      ['a', 100],
      ['b', 100],
    ]);
    expect(recipeCoverage(reqs, pantry)).toBeCloseTo(2 / 3, 5);
  });
});
