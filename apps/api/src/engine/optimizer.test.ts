// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  OptimizerError,
  fitServings,
  optimisePlan,
  recipeCoverage,
  requirementsPerServing,
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

  it('throws when a slot has no eligible recipe, and says which meal and diet', () => {
    const attempt = () => optimisePlan({ ...baseInput, days: uniformDays(1, ['breakfast', 'snack'], 2000) });

    expect(attempt).toThrow(OptimizerError);
    expect(attempt).toThrow(expect.objectContaining({ gap: { slot: 'snack', dietType: baseInput.dietType } }));
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

  // ── Advanced per-day options ──────────────────────────────────────────

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

  it('biases a day toward its inventory-coverage map (use-up-by)', () => {
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

describe('a plan for somebody who would rather not eat something', () => {
  /** Seven days of a breakfast, a lunch and a dinner; the lunches may repeat, so that one lunch alone can fill the week. */
  const aWeek = (over: Partial<OptimizerInput>): OptimizerInput => ({ ...baseInput, days: uniformDays(7, ['breakfast', 'lunch', 'dinner'], 2000), maxConsecutiveDaysSameMeal: 7, maxTimesPerWeekSameMeal: 7, ...over });
  const lunches = (input: OptimizerInput): string[] => optimisePlan(input).assignments.filter((a) => a.slot === 'lunch').map((a) => a.recipeId);

  it('holds no recipe with it at a meal that has another, whatever seed the choice is drawn with', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      // Without the dislike both lunches are planned: the choice between them is the seed's and the week's.
      expect(new Set(lunches(aWeek({ seed })))).toEqual(new Set(['l1', 'l2']));
      expect(new Set(lunches(aWeek({ seed, dislikedIngredientIds: new Set(['l1-a']) })))).toEqual(new Set(['l2']));
    }
  });

  it('holds one all the same where every recipe left for the meal has it: a dislike rules nothing out', () => {
    // Every recipe of the plan holds the ingredient they share.
    const result = optimisePlan(aWeek({ dislikedIngredientIds: new Set(['shared']) }));

    expect(result.assignments).toHaveLength(7 * 3);
  });

  it('breaks no limit for it: once the limits leave only what is disliked, that is planned', () => {
    // Six days, a recipe at most three times in a week, and no limit that may give way: the lunch that is liked can fill three of them.
    const strict = aWeek({ days: uniformDays(6, ['breakfast', 'lunch', 'dinner'], 2000), maxTimesPerWeekSameMeal: 3, dislikedIngredientIds: new Set(['l1-a']), allowRelaxations: new Set() });

    // The liked one as long as it may be, then the other: not the two in turn, as a week without a dislike would have them.
    expect(lunches(strict)).toEqual(['l2', 'l2', 'l2', 'l1', 'l1', 'l1']);
  });

  it('changes nothing for somebody who dislikes nothing, or nothing that is in the catalogue', () => {
    const plain = optimisePlan(aWeek({})).assignments;

    expect(optimisePlan(aWeek({ dislikedIngredientIds: new Set() })).assignments).toEqual(plain);
    expect(optimisePlan(aWeek({ dislikedIngredientIds: new Set(['in-no-recipe']) })).assignments).toEqual(plain);
  });
});

describe('a plan for somebody who marked recipes', () => {
  /** Two lunches alike in everything but how they are marked. */
  const twoLunches = (first: Partial<OptimizerRecipe>, second: Partial<OptimizerRecipe>, seed: number): OptimizerInput => ({
    ...baseInput,
    recipes: [recipe('b1', ['breakfast'], 500), { ...recipe('l-first', ['lunch'], 700), ...first }, { ...recipe('l-second', ['lunch'], 700), ...second }, recipe('d1', ['dinner'], 600)],
    days: uniformDays(1, ['breakfast', 'lunch', 'dinner'], 2000),
    seed,
  });
  const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
  const firstChosen = (first: Partial<OptimizerRecipe>, second: Partial<OptimizerRecipe>): number =>
    SEEDS.filter((seed) => optimisePlan(twoLunches(first, second, seed)).assignments.find((a) => a.slot === 'lunch')!.recipeId === 'l-first').length;

  it('leans towards one that is eaten often more than towards one that is merely a favourite', () => {
    const favourite = firstChosen({ isFavorite: true }, {});
    const often = firstChosen({ isFavorite: true, eatenOften: true }, {});
    const oftenAgainstFavourite = firstChosen({ isFavorite: true, eatenOften: true }, { isFavorite: true });

    expect(often).toBeGreaterThan(favourite);
    // Against a favourite it still leads, and not every time: a lean, as every mark is.
    expect(oftenAgainstFavourite).toBeGreaterThan(SEEDS.length / 2);
    expect(oftenAgainstFavourite).toBeLessThan(SEEDS.length);
  });
});

describe('a plan for somebody who prefers a cuisine', () => {
  /** Two lunches alike in everything but where they come from. */
  const twoLunches = (over: Partial<OptimizerInput>): OptimizerInput => ({
    ...baseInput,
    recipes: [recipe('b1', ['breakfast'], 500), { ...recipe('l-asian', ['lunch'], 700), cuisine: 'asian' }, { ...recipe('l-plain', ['lunch'], 700), cuisine: null }, recipe('d1', ['dinner'], 600)],
    days: uniformDays(1, ['breakfast', 'lunch', 'dinner'], 2000),
    ...over,
  });
  const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
  const asianLunches = (over: Partial<OptimizerInput>): number =>
    SEEDS.filter((seed) => optimisePlan(twoLunches({ ...over, seed })).assignments.find((a) => a.slot === 'lunch')!.recipeId === 'l-asian').length;

  it('leans towards a recipe of that cuisine, and rules no other out', () => {
    const without = asianLunches({});
    const preferred = asianLunches({ preferredCuisines: new Set(['asian']) });

    // A lean: more often than chance has it, and not every time.
    expect(preferred).toBeGreaterThan(without);
    expect(preferred).toBeGreaterThan(SEEDS.length * 0.7);
    expect(preferred).toBeLessThan(SEEDS.length);
  });

  it('changes nothing for somebody who prefers none, or one no recipe has', () => {
    for (const seed of [1, 2, 3]) {
      const plain = optimisePlan(twoLunches({ seed })).assignments;

      expect(optimisePlan(twoLunches({ seed, preferredCuisines: new Set() })).assignments).toEqual(plain);
      expect(optimisePlan(twoLunches({ seed, preferredCuisines: new Set(['polish']) })).assignments).toEqual(plain);
    }
  });
});

describe('a plan and the packs it opens', () => {
  /** Chicken comes in packs of 600 g, and what is left of an opened one does not keep. */
  const PACKS = new Map([['chicken', 600]]);
  const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
  /**
   * A day whose lunch takes `lunchGrams` of chicken, and two dinners alike in
   * everything, but that one takes `dinnerGrams` of chicken and the other none.
   * Both share as many ingredients with the day so far. Each meal is what its
   * part of the day comes to, so each is one serving.
   */
  const aDay = (lunchGrams: number, dinnerGrams: number, over: Partial<OptimizerInput>): OptimizerInput => ({
    ...baseInput,
    recipes: [
      recipe('b1', ['breakfast'], 500),
      { ...recipe('l1', ['lunch'], 800), ingredientIds: ['l1-a', 'chicken', 'shared'], amounts: new Map([['chicken', lunchGrams]]) },
      { ...recipe('d-chicken', ['dinner'], 700), ingredientIds: ['d1-a', 'chicken', 'shared'], amounts: new Map([['chicken', dinnerGrams]]) },
      { ...recipe('d-plain', ['dinner'], 700), ingredientIds: ['d2-a', 'l1-a', 'shared'], amounts: new Map([['lentils', 80]]) },
    ],
    days: uniformDays(1, ['breakfast', 'lunch', 'dinner'], 2000),
    ...over,
  });
  const chickenDinners = (lunchGrams: number, dinnerGrams: number, over: Partial<OptimizerInput> = {}): number =>
    SEEDS.filter((seed) => optimisePlan(aDay(lunchGrams, dinnerGrams, { ...over, seed })).assignments.find((a) => a.slot === 'dinner')!.recipeId === 'd-chicken').length;

  it('is made of one serving a meal here, so that the grams above are the grams planned', () => {
    expect(optimisePlan(aDay(200, 200, { seed: 1 })).assignments.map((a) => a.servings)).toEqual([1, 1, 1]);
  });

  it('leans towards the meal that takes from a pack the plan has opened and mostly left', () => {
    // Lunch took 200 g of the 600: two thirds of the pack would be left.
    const without = chickenDinners(200, 200);
    const withPacks = chickenDinners(200, 200, { perishablePacks: PACKS });

    expect(withPacks).toBeGreaterThan(without);
    expect(withPacks).toBeGreaterThan(SEEDS.length * 0.7);
  });

  it('leans away from the meal that would open another pack for what a used one cannot give', () => {
    // Lunch took 550 g: the 150 g of the dinner would open a second pack and leave most of it.
    const without = chickenDinners(550, 150);
    const withPacks = chickenDinners(550, 150, { perishablePacks: PACKS });

    expect(withPacks).toBeLessThan(without);
    expect(withPacks).toBeLessThan(SEEDS.length * 0.3);
  });

  it('has nothing to say of what is left of a pack that is used well enough', () => {
    // 550 g of 600 are used, and a dinner could take the last 50 g: no reason to plan it, and none against.
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(optimisePlan(aDay(550, 50, { seed, perishablePacks: PACKS })).assignments).toEqual(optimisePlan(aDay(550, 50, { seed })).assignments);
    }
  });

  /** Days whose dinners are alike in everything, but that one opens a tub of yogurt and takes 150 g of its 500. */
  const withATub = (days: number, over: Partial<OptimizerInput>): OptimizerInput => ({
    ...baseInput,
    recipes: [
      recipe('b1', ['breakfast'], 500),
      recipe('l1', ['lunch'], 800),
      { ...recipe('d-yogurt', ['dinner'], 700), ingredientIds: ['d1-a', 'yogurt', 'shared'], amounts: new Map([['yogurt', 150]]) },
      { ...recipe('d-plain', ['dinner'], 700), ingredientIds: ['d2-a', 'lentils', 'shared'], amounts: new Map([['lentils', 80]]) },
    ],
    days: uniformDays(days, ['breakfast', 'lunch', 'dinner'], 2000),
    ...over,
  });
  const TUB = new Map([['yogurt', 500]]);
  const firstDinner = (days: number, over: Partial<OptimizerInput>): string => optimisePlan(withATub(days, over)).assignments.find((a) => a.dayIndex === 0 && a.slot === 'dinner')!.recipeId;

  it('leans away from the meal that opens a pack on the last day of a plan and would leave most of it', () => {
    const without = SEEDS.filter((seed) => firstDinner(1, { seed }) === 'd-yogurt').length;
    const withPacks = SEEDS.filter((seed) => firstDinner(1, { seed, perishablePacks: TUB }) === 'd-yogurt').length;

    expect(without).toBeGreaterThan(SEEDS.length * 0.3);
    expect(withPacks).toBeLessThan(without / 2);
  });

  it('holds a pack against no meal that opens it with a week of the plan still to come', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(firstDinner(8, { seed, perishablePacks: TUB }), `seed ${seed}`).toBe(firstDinner(8, { seed }));
    }
  });

  it('changes nothing where no ingredient of the plan comes in such a pack', () => {
    for (const seed of [1, 2, 3]) {
      const plain = optimisePlan(aDay(200, 200, { seed })).assignments;

      expect(optimisePlan(aDay(200, 200, { seed, perishablePacks: new Map() })).assignments).toEqual(plain);
      expect(optimisePlan(aDay(200, 200, { seed, perishablePacks: new Map([['yogurt', 500]]) })).assignments).toEqual(plain);
    }
  });
});

describe('a plan made for cooking ahead', () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
  /** Four days of one meal, with four lunches alike to choose from. */
  const fourLunches = (mealPrepFriendly: boolean, seed: number): string[] =>
    optimisePlan({
      ...baseInput,
      recipes: ['l1', 'l2', 'l3', 'l4'].map((id) => recipe(id, ['lunch'], 700)),
      days: uniformDays(4, ['lunch'], 700),
      mealPrepFriendly,
      maxConsecutiveDaysSameMeal: mealPrepFriendly ? 4 : 2,
      maxTimesPerWeekSameMeal: mealPrepFriendly ? 5 : 3,
      seed,
    }).assignments.map((a) => a.recipeId);

  it('has a recipe on two days running, and then another: cooked once, eaten twice', () => {
    for (const seed of SEEDS) {
      const [first, second, third, fourth] = fourLunches(true, seed);

      expect([second, fourth], `seed ${seed}`).toEqual([first, third]);
      expect(third, `seed ${seed}`).not.toBe(first);
    }
  });

  it('is what makes it so: a plan that was not asked for it has another recipe the day after', () => {
    const repeats = SEEDS.filter((seed) => {
      const [first, second] = fourLunches(false, seed);
      return first === second;
    });

    expect(repeats).toEqual([]);
  });
});

describe('a day that is to do without some recipes', () => {
  /** One day of three meals, with two recipes for each. */
  const twoEach: OptimizerInput = {
    ...baseInput,
    recipes: [recipe('b1', ['breakfast'], 500), recipe('b2', ['breakfast'], 500), recipe('l1', ['lunch'], 800), recipe('l2', ['lunch'], 800), recipe('d1', ['dinner'], 700), recipe('d2', ['dinner'], 700)],
    days: uniformDays(1, ['breakfast', 'lunch', 'dinner'], 2000),
  };
  const filled = (avoid: string[], over: Partial<OptimizerInput> = {}, seed = 1): string[] =>
    optimisePlan({ ...twoEach, ...over, days: [{ ...twoEach.days[0]!, avoid: new Set(avoid) }], seed }).assignments.map((placed) => placed.recipeId);

  it('is filled with the others, whatever the draw', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(filled(['b1', 'l2', 'd1'], {}, seed), `seed ${seed}`).toEqual(['b2', 'l1', 'd2']);
    }
  });

  it('takes one of them where no other recipe is there for the meal: they order the choice and rule nothing out', () => {
    expect(filled(['b1', 'b2', 'l1'])).toEqual([expect.stringMatching(/^b[12]$/), 'l2', expect.stringMatching(/^d[12]$/)]);
  });

  it('takes one of them before it lets a limit give way for another', () => {
    // The other lunch was eaten on the two days before: a third day running is outside the limit.
    const kept = { calories: 800, servings: 1 };
    const days = [
      { mealSlots: [], dailyCalorieTarget: 2000, kept: [{ ...kept, recipeId: 'l2' }] },
      { mealSlots: [], dailyCalorieTarget: 2000, kept: [{ ...kept, recipeId: 'l2' }] },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 800, avoid: new Set(['l1']) },
    ];

    const result = optimisePlan({ ...twoEach, days, maxConsecutiveDaysSameMeal: 2 });

    expect(result.assignments.map((placed) => placed.recipeId)).toEqual(['l1']);
    expect(result.report.relaxations).toEqual([]);
  });

  it('is filled as any day where it is to do without nothing', () => {
    expect(filled([], {}, 3)).toEqual(optimisePlan({ ...twoEach, seed: 3 }).assignments.map((placed) => placed.recipeId));
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

describe('what one serving of a recipe needs', () => {
  const chicken = { canonicalUnit: 'g' as const, gramsPerPiece: null, density: null };
  const egg = { canonicalUnit: 'g' as const, gramsPerPiece: 55, density: null };
  const milk = { canonicalUnit: 'ml' as const, gramsPerPiece: null, density: 1.03 };

  it('is the recipe divided by its servings, in canonical units', () => {
    const needs = requirementsPerServing({
      servings: 2,
      ingredients: [
        { ingredientId: 'chicken', quantity: 300, unit: 'g', ingredient: chicken },
        { ingredientId: 'egg', quantity: 4, unit: 'piece', ingredient: egg },
        { ingredientId: 'milk', quantity: 206, unit: 'g', ingredient: milk },
      ],
    });

    expect(needs).toEqual([
      { ingredientId: 'chicken', canonicalQuantity: 150 },
      { ingredientId: 'egg', canonicalQuantity: 110 },
      { ingredientId: 'milk', canonicalQuantity: 100 },
    ]);
  });

  it('makes a pantry that holds one serving cover a two-serving recipe in full', () => {
    const recipe = { servings: 2, ingredients: [{ ingredientId: 'chicken', quantity: 300, unit: 'g' as const, ingredient: chicken }] };

    expect(recipeCoverage(requirementsPerServing(recipe), new Map([['chicken', 150]]))).toBe(1);
  });

  it('leaves out a line that cannot be converted, and one of nothing', () => {
    const needs = requirementsPerServing({
      servings: 1,
      ingredients: [
        { ingredientId: 'chicken', quantity: 2, unit: 'piece', ingredient: chicken },
        { ingredientId: 'egg', quantity: 0, unit: 'g', ingredient: egg },
        { ingredientId: 'milk', quantity: 100, unit: 'ml', ingredient: milk },
      ],
    });

    expect(needs).toEqual([{ ingredientId: 'milk', canonicalQuantity: 100 }]);
  });

  it('takes a recipe that claims no servings as one serving', () => {
    const needs = requirementsPerServing({ servings: 0, ingredients: [{ ingredientId: 'chicken', quantity: 300, unit: 'g', ingredient: chicken }] });

    expect(needs).toEqual([{ ingredientId: 'chicken', canonicalQuantity: 300 }]);
  });
});
