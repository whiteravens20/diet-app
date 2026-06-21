import { describe, expect, it } from 'vitest';
import {
  OptimizerError,
  fitServings,
  optimisePlan,
  recipeCoverage,
  slotBudgets,
  uniformDays,
  type OptimizerInput,
  type OptimizerRecipe,
} from './optimizer.js';

function recipe(
  id: string,
  slots: OptimizerRecipe['mealTypes'],
  cals: number,
  totalMinutes = 20,
): OptimizerRecipe {
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
    totalMinutes,
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
  days: uniformDays(3, ['breakfast', 'lunch', 'dinner'], 2000),
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
    expect(() => optimisePlan({ ...baseInput, days: uniformDays(1, ['snack'], 2000) })).toThrow(
      OptimizerError,
    );
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
    const slots: OptimizerRecipe['mealTypes'] = ['breakfast', 'lunch', 'dinner'];
    const longInput: OptimizerInput = {
      ...baseInput,
      recipes: [
        ...baseInput.recipes,
        recipe('b3', ['breakfast'], 480),
        recipe('l3', ['lunch'], 680),
        recipe('d3', ['dinner'], 580),
      ],
      days: uniformDays(28, slots, 2000),
      maxConsecutiveDaysSameMeal: 2,
      maxTimesPerWeekSameMeal: 3,
    };
    const result = optimisePlan(longInput);

    // No three identical recipes in a row at any slot.
    for (const slot of slots) {
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

  // ── F17 advanced per-day options ──────────────────────────────────────────

  it('honours a per-day calorie target (different servings per day)', () => {
    const result = optimisePlan({
      ...baseInput,
      recipes: [recipe('b1', ['breakfast'], 450)],
      days: [
        { mealSlots: ['breakfast'], dailyCalorieTarget: 450 },
        { mealSlots: ['breakfast'], dailyCalorieTarget: 1350 },
      ],
    });
    const day0 = result.assignments.find((a) => a.dayIndex === 0)!;
    const day1 = result.assignments.find((a) => a.dayIndex === 1)!;
    expect(day0.servings).toBe(1); // 450 / 450
    expect(day1.servings).toBe(3); // 1350 / 450
    expect(day1.servings).not.toBe(day0.servings);
  });

  it('honours a per-day meal count (different slot set per day)', () => {
    const result = optimisePlan({
      ...baseInput,
      days: [
        { mealSlots: ['breakfast', 'dinner'], dailyCalorieTarget: 2000 },
        { mealSlots: ['breakfast', 'lunch', 'dinner'], dailyCalorieTarget: 2000 },
      ],
    });
    expect(result.assignments.filter((a) => a.dayIndex === 0)).toHaveLength(2);
    expect(result.assignments.filter((a) => a.dayIndex === 1)).toHaveLength(3);
  });

  it('produces no meals for a skipped day', () => {
    const result = optimisePlan({
      ...baseInput,
      days: [
        { mealSlots: ['breakfast', 'lunch', 'dinner'], dailyCalorieTarget: 2000 },
        { mealSlots: ['breakfast', 'lunch', 'dinner'], dailyCalorieTarget: 2000, skip: true },
        { mealSlots: ['breakfast', 'lunch', 'dinner'], dailyCalorieTarget: 2000 },
      ],
    });
    expect(result.assignments.filter((a) => a.dayIndex === 1)).toHaveLength(0);
    expect(result.assignments.filter((a) => a.dayIndex === 0)).toHaveLength(3);
    expect(result.assignments.filter((a) => a.dayIndex === 2)).toHaveLength(3);
  });

  it('places a locked slot and fills the rest of the day around it', () => {
    const result = optimisePlan({
      ...baseInput,
      days: [
        {
          mealSlots: ['breakfast', 'lunch', 'dinner'],
          dailyCalorieTarget: 2000,
          lockedSlots: [{ slot: 'breakfast', recipeId: 'b2' }],
        },
      ],
    });
    const breakfast = result.assignments.find((a) => a.slot === 'breakfast')!;
    expect(breakfast.recipeId).toBe('b2');
    expect(result.assignments.map((a) => a.slot).sort()).toEqual(['breakfast', 'dinner', 'lunch']);
  });

  it('throws when a locked recipe is not in the candidate set', () => {
    expect(() =>
      optimisePlan({
        ...baseInput,
        days: [
          {
            mealSlots: ['breakfast'],
            dailyCalorieTarget: 2000,
            lockedSlots: [{ slot: 'breakfast', recipeId: 'does-not-exist' }],
          },
        ],
      }),
    ).toThrow(OptimizerError);
  });

  it('caps total uses of a recipe at maxRepeatsPerRecipe', () => {
    const result = optimisePlan({
      ...baseInput,
      recipes: [
        recipe('b1', ['breakfast'], 500),
        recipe('b2', ['breakfast'], 500),
        recipe('b3', ['breakfast'], 500),
      ],
      days: uniformDays(3, ['breakfast'], 500),
      maxRepeatsPerRecipe: 1,
    });
    const ids = result.assignments.map((a) => a.recipeId);
    expect(new Set(ids).size).toBe(3); // all distinct — none reused
  });

  it('falls back past the variety floor rather than failing generation', () => {
    const result = optimisePlan({
      ...baseInput,
      recipes: [recipe('b1', ['breakfast'], 500)],
      days: uniformDays(3, ['breakfast'], 500),
      maxRepeatsPerRecipe: 1,
    });
    // Only one recipe, cap of 1, three days → the cap is relaxed, not thrown.
    expect(result.assignments.map((a) => a.recipeId)).toEqual(['b1', 'b1', 'b1']);
  });

  it('respects a per-day cook-time budget, then falls back when it would empty the pool', () => {
    const recipes = [recipe('fast', ['breakfast'], 500, 10), recipe('slow', ['breakfast'], 500, 90)];
    const picked = optimisePlan({
      ...baseInput,
      recipes,
      days: [{ mealSlots: ['breakfast'], dailyCalorieTarget: 500, cookTimeBudgetMinutes: 15 }],
    });
    expect(picked.assignments[0]!.recipeId).toBe('fast');

    // A budget no recipe can meet falls back to the eligible pool (no throw).
    const fallback = optimisePlan({
      ...baseInput,
      recipes,
      days: [{ mealSlots: ['breakfast'], dailyCalorieTarget: 500, cookTimeBudgetMinutes: 5 }],
    });
    expect(fallback.assignments).toHaveLength(1);
  });

  it('biases a day toward its inventory-coverage map (F15 use-up-by)', () => {
    const recipes = [recipe('r1', ['breakfast'], 500), recipe('r2', ['breakfast'], 500)];
    const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
    const countR2 = (coverage?: ReadonlyMap<string, number>) =>
      seeds.filter((seed) => {
        const out = optimisePlan({
          ...baseInput,
          recipes,
          seed,
          days: [{ mealSlots: ['breakfast'], dailyCalorieTarget: 500, inventoryCoverage: coverage }],
        });
        return out.assignments[0]!.recipeId === 'r2';
      }).length;

    // With r2 marked as covering expiring stock it wins more often than the
    // unbiased baseline — proving the per-day coverage map is honoured.
    expect(countR2(new Map([['r2', 1]]))).toBeGreaterThan(countR2(undefined));
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
