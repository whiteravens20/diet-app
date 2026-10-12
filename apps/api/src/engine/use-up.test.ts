// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { packUse } from './packs.js';
import { tallyOf, useUpSwaps, type UseUpCandidate, type UseUpMeal } from './use-up.js';

/** Beef in packs of 500 g, feta in packs of 200 g, yogurt in tubs of 400 g. */
const PACKS = new Map([
  ['beef', 500],
  ['feta', 200],
  ['yogurt', 400],
]);
const amounts = (of: Record<string, number>): Map<string, number> => new Map(Object.entries(of));
const recipe = (recipeId: string, caloriesPerServing: number, of: Record<string, number>): UseUpCandidate => ({ recipeId, caloriesPerServing, amounts: amounts(of) });
const meal = (id: string, recipeId: string, held: number, of: Record<string, number>, candidates: UseUpCandidate[] = []): UseUpMeal => ({ id, recipeId, held, amounts: amounts(of), candidates });
const NOTHING = new Map<string, number>();

describe('the swaps that use up what a plan opens', () => {
  /** A dinner of beef that takes 180 g of a pack of 500, and a lunch of lentils that could be beef as well. */
  const beefDinner = meal('dinner-1', 'beef-pasta', 700, { beef: 180, pasta: 90 });
  const beefBowl = recipe('beef-bowl', 700, { beef: 200, rice: 80 });
  const lentilLunch = (candidates: UseUpCandidate[]) => meal('lunch-2', 'lentil-soup', 700, { lentils: 90 }, candidates);

  it('are the recipes that take from a pack the menu leaves more than three tenths of', () => {
    const [swap, ...others] = useUpSwaps([beefDinner, lentilLunch([beefBowl, recipe('veg-curry', 700, { rice: 90 })])], NOTHING, PACKS);

    expect(others).toEqual([]);
    expect(swap).toMatchObject({ mealId: 'lunch-2', recipeId: 'beef-bowl', servings: 1 });
    // 180 g of 500 were used: with the bowl 380 g are, and the pack counts as used.
    expect(swap!.before).toEqual({ bought: 500, used: 180, wasted: 1 });
    expect(swap!.after).toEqual({ bought: 500, used: 380, wasted: 0 });
    expect([...swap!.takes]).toEqual([['beef', { amount: 200, left: 120 }]]);
  });

  it('size the recipe to what the meal holds, as a swap does', () => {
    // A lunch of 1050 kcal takes a serving and a half of the bowl: 300 g of beef.
    const [swap] = useUpSwaps([beefDinner, meal('lunch-2', 'lentil-soup', 1050, { lentils: 135 }, [beefBowl])], NOTHING, PACKS);

    expect(swap).toMatchObject({ servings: 1.5, after: { bought: 500, used: 480, wasted: 0 } });
    expect(swap!.takes.get('beef')).toEqual({ amount: 300, left: 20 });
  });

  it('are none where the menu leaves no pack more than three tenths full', () => {
    const used = meal('dinner-1', 'beef-pasta', 700, { beef: 400 });

    expect(useUpSwaps([used, lentilLunch([beefBowl])], NOTHING, PACKS)).toEqual([]);
    expect(useUpSwaps([], NOTHING, PACKS)).toEqual([]);
  });

  it('leave out a swap that finishes one pack by opening another and leaving as much of that', () => {
    // The feta salad would take the feta that is left, and open a tub of yogurt for a spoonful of it.
    const fetaBreakfast = meal('breakfast-1', 'feta-toast', 400, { feta: 60 });
    const salad = recipe('feta-yogurt-salad', 700, { feta: 100, yogurt: 60 });

    expect(useUpSwaps([fetaBreakfast, lentilLunch([salad])], NOTHING, PACKS)).toEqual([]);
  });

  it('count what the swap takes away with the recipe that leaves: a meal that held the pack does not use it up by leaving', () => {
    // The only beef of the menu is the dinner's: another beef dish in its place changes nothing.
    const dinner = meal('dinner-1', 'beef-pasta', 700, { beef: 180 }, [recipe('beef-stew', 700, { beef: 190 })]);

    expect(useUpSwaps([dinner], NOTHING, PACKS)).toEqual([]);
  });

  it('count what the meals that cannot be changed take', () => {
    // Yesterday's dinner, eaten, opened the beef: today's lunch can still use it.
    const [swap] = useUpSwaps([lentilLunch([beefBowl])], amounts({ beef: 180 }), PACKS);

    expect(swap).toMatchObject({ mealId: 'lunch-2', recipeId: 'beef-bowl', before: { used: 180, wasted: 1 }, after: { used: 380, wasted: 0 } });
  });

  it('give one swap for a meal, the one that leaves the least, and the meals in the order of what is left', () => {
    const feta = meal('breakfast-1', 'feta-toast', 400, { feta: 40 });
    const lunch = lentilLunch([recipe('beef-wrap', 700, { beef: 120 }), beefBowl]);
    const snack = meal('snack-2', 'apple', 300, { apple: 180 }, [recipe('feta-plate', 300, { feta: 110 })]);

    const swaps = useUpSwaps([beefDinner, feta, lunch, snack], NOTHING, PACKS);

    // The bowl takes more of the beef than the wrap; the plate brings the feta to three quarters.
    expect(swaps.map((swap) => [swap.mealId, swap.recipeId])).toEqual([
      ['snack-2', 'feta-plate'],
      ['lunch-2', 'beef-bowl'],
    ]);
    expect(swaps[0]!.before).toEqual(swaps[1]!.before);
  });

  it('give no more than asked for', () => {
    const lunches = Array.from({ length: 8 }, (_, index) => meal(`lunch-${index}`, 'lentil-soup', 700, { lentils: 90 }, [beefBowl]));

    expect(useUpSwaps([beefDinner, ...lunches], NOTHING, PACKS)).toHaveLength(5);
    expect(useUpSwaps([beefDinner, ...lunches], NOTHING, PACKS, 2)).toHaveLength(2);
  });

  it('never offer a meal the recipe it holds', () => {
    const dinner = meal('dinner-1', 'beef-pasta', 700, { beef: 180 });
    const again = meal('dinner-2', 'beef-bowl', 700, { beef: 20, rice: 80 }, [beefBowl]);

    expect(useUpSwaps([dinner, again], NOTHING, PACKS)).toEqual([]);
  });
});

describe('what a menu buys in packs, in three numbers', () => {
  it('is what it buys, what it uses, and how many packs it leaves more than three tenths of', () => {
    expect(tallyOf(packUse(amounts({ beef: 180, feta: 150, yogurt: 100 }), PACKS))).toEqual({ bought: 1100, used: 430, wasted: 2 });
  });
});
