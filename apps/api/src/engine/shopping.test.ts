// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  type PlanIngredientLine,
  type ShoppingIngredient,
  type ShoppingRowState,
  aggregateShoppingList,
  editRow,
  groupByAisle,
  heldForPlan,
  intendedPantryEffect,
  pantryEffectOnRemoval,
  shareAhead,
  toBuyQuantity,
} from './shopping.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
function ing(over: Partial<ShoppingIngredient> & Pick<ShoppingIngredient, 'id' | 'name'>): ShoppingIngredient {
  return {
    category: 'vegetables',
    canonicalUnit: 'g',
    caloriesPer100: 0,
    proteinPer100: 0,
    fatPer100: 0,
    carbsPer100: 0,
    gramsPerPiece: null,
    density: null,
    displayUnit: null,
    allergens: [],
    dietCompatibility: [],
    ...over,
  };
}

const tomato = ing({
  id: 't',
  name: 'Tomato',
  category: 'vegetables',
  caloriesPer100: 18,
  gramsPerPiece: 120,
});
const broccoli = ing({ id: 'b', name: 'Broccoli', category: 'vegetables', caloriesPer100: 34 });
const apple = ing({ id: 'a', name: 'Apple', category: 'fruits', caloriesPer100: 52, gramsPerPiece: 180 });
const avocado = ing({ id: 'av', name: 'Avocado', category: 'fruits', caloriesPer100: 160 });
const milk = ing({
  id: 'm',
  name: 'Milk',
  category: 'dairy',
  canonicalUnit: 'ml',
  caloriesPer100: 42,
  density: 1.03,
});

/** Counted, not weighed: 55 g each. */
const egg = ing({ id: 'e', name: 'Large egg', category: 'dairy', caloriesPer100: 143, gramsPerPiece: 55, displayUnit: 'piece' });
const bread = ing({ id: 'br', name: 'Bread', category: 'grains', caloriesPer100: 247, gramsPerPiece: 40, displayUnit: 'slice' });

const DB = new Map<string, ShoppingIngredient>(
  [tomato, broccoli, apple, avocado, milk, egg, bread].map((i) => [i.id, i]),
);

function line(over: Partial<PlanIngredientLine> & Pick<PlanIngredientLine, 'ingredientId'>): PlanIngredientLine {
  return { quantity: 100, unit: 'g', recipeServings: 1, plannedServings: 1, ...over };
}

// ── aggregateShoppingList ─────────────────────────────────────────────────────
describe('aggregateShoppingList', () => {
  it('merges duplicate ingredient lines into one summed item', () => {
    const groups = aggregateShoppingList(
      [line({ ingredientId: 't', quantity: 100 }), line({ ingredientId: 't', quantity: 150 })],
      DB,
    );
    const veg = groups.find((g) => g.category === 'vegetables')!;
    expect(veg.items).toHaveLength(1);
    expect(veg.items[0]).toMatchObject({ ingredientId: 't', totalQuantity: 250, unit: 'g' });
  });

  it('scales each line by plannedServings / recipeServings', () => {
    const groups = aggregateShoppingList(
      [line({ ingredientId: 't', quantity: 100, recipeServings: 2, plannedServings: 4 })],
      DB,
    );
    // 100 g × (4 / 2) = 200 g
    expect(groups[0].items[0].totalQuantity).toBe(200);
  });

  it('treats recipeServings of 0 as scale 1 (no divide-by-zero)', () => {
    const groups = aggregateShoppingList(
      [line({ ingredientId: 't', quantity: 100, recipeServings: 0, plannedServings: 4 })],
      DB,
    );
    expect(groups[0].items[0].totalQuantity).toBe(100);
  });

  it('normalises non-canonical units to the canonical unit', () => {
    // 2 pieces of tomato × 120 g/piece = 240 g
    const groups = aggregateShoppingList(
      [line({ ingredientId: 't', quantity: 2, unit: 'piece' })],
      DB,
    );
    expect(groups[0].items[0]).toMatchObject({ totalQuantity: 240, unit: 'g' });
  });

  it('rounds the need up to what one buys: the next 5 g, never below the need', () => {
    const need = (quantity: number) =>
      aggregateShoppingList([line({ ingredientId: 'b', quantity })], DB)[0]!.items[0]!.totalQuantity;

    expect(need(212.4)).toBe(215);
    expect(need(100.04)).toBe(105);
    expect(need(215)).toBe(215);
    expect(need(3.2)).toBe(4);
  });

  it('counts eggs and bread in pieces, whatever unit the recipes wrote them in, and asks for whole ones', () => {
    const groups = aggregateShoppingList(
      [
        // 110 g and one piece and a fifth of one: 3.2 eggs.
        line({ ingredientId: 'e', quantity: 110 }),
        line({ ingredientId: 'e', quantity: 1.2, unit: 'piece' }),
        line({ ingredientId: 'br', quantity: 80 }),
      ],
      DB,
    );
    const items = groups.flatMap((g) => g.items);

    expect(items.find((i) => i.ingredientId === 'e')).toMatchObject({ totalQuantity: 4, unit: 'piece', displayUnit: 'piece' });
    expect(items.find((i) => i.ingredientId === 'br')).toMatchObject({ totalQuantity: 2, unit: 'piece', displayUnit: 'slice' });
  });

  it('keeps a weighed ingredient in grams even though a recipe may count it', () => {
    const item = aggregateShoppingList([line({ ingredientId: 't', quantity: 2, unit: 'piece' })], DB)[0]!.items[0]!;

    expect(item).toMatchObject({ totalQuantity: 240, unit: 'g', displayUnit: 'g' });
  });

  it('estimates calories from the exact need, not from the rounded one', () => {
    const groups = aggregateShoppingList([line({ ingredientId: 't', quantity: 200 })], DB);
    // 200 g tomato at 18 kcal/100 g = 36 kcal
    expect(groups[0].items[0].estimatedCalories).toBe(36);
    // 3.2 eggs are 176 g: 252 kcal, although four eggs are bought.
    const eggs = aggregateShoppingList([line({ ingredientId: 'e', quantity: 176 })], DB)[0]!.items[0]!;
    expect(eggs.estimatedCalories).toBe(252);
  });

  it('groups items by category in canonical order', () => {
    const groups = aggregateShoppingList(
      [
        line({ ingredientId: 'm', unit: 'ml' }), // dairy
        line({ ingredientId: 'a' }), // fruits
        line({ ingredientId: 't' }), // vegetables
      ],
      DB,
    );
    expect(groups.map((g) => g.category)).toEqual(['vegetables', 'fruits', 'dairy']);
  });

  it('sorts items alphabetically within a category', () => {
    const groups = aggregateShoppingList(
      [line({ ingredientId: 'av' }), line({ ingredientId: 'a' })],
      DB,
    );
    const fruits = groups.find((g) => g.category === 'fruits')!;
    expect(fruits.items.map((i) => i.name)).toEqual(['Apple', 'Avocado']);
  });

  it('omits categories with no items', () => {
    const groups = aggregateShoppingList([line({ ingredientId: 't' })], DB);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe('vegetables');
  });

  it('returns an empty array for no lines', () => {
    expect(aggregateShoppingList([], DB)).toEqual([]);
  });

  it('throws on an ingredient missing from the database', () => {
    expect(() => aggregateShoppingList([line({ ingredientId: 'ghost' })], DB)).toThrow(
      /unknown ingredient ghost/,
    );
  });
});

// ── toBuyQuantity ─────────────────────────────────────────────────────────────
describe('toBuyQuantity', () => {
  it('deducts what the user already has', () => {
    expect(toBuyQuantity(250, 100)).toBe(150);
  });

  it('floors at zero when the user has more than the recipe needs', () => {
    expect(toBuyQuantity(50, 200)).toBe(0);
  });

  it('is free of floating-point noise', () => {
    expect(toBuyQuantity(0.3, 0.1)).toBe(0.2);
  });
});

describe('the aisles', () => {
  it('come in the same order whatever order the rows arrive in', () => {
    const rows = [
      { name: 'Milk', category: 'dairy' as const },
      { name: 'Tomato', category: 'vegetables' as const },
      { name: 'Apple', category: 'fruits' as const },
      { name: 'Broccoli', category: 'vegetables' as const },
    ];

    const grouped = groupByAisle([...rows].reverse());

    expect(grouped.map((g) => g.category)).toEqual(['vegetables', 'fruits', 'dairy']);
    expect(grouped[0]!.items.map((i) => i.name)).toEqual(['Broccoli', 'Tomato']);
  });
});

/** A row for 700 g of which the list found 200 g at home. */
const row = (over: Partial<ShoppingRowState> = {}): ShoppingRowState => ({
  totalQuantity: 700,
  alreadyHaveQuantity: 200,
  purchasedQuantity: 200,
  checked: false,
  ...over,
});

describe('editing a row', () => {
  it('ticks itself when the quantity reaches the need, and unticks when it falls below', () => {
    expect(editRow(row(), { purchasedQuantity: 700 })).toEqual({ purchasedQuantity: 700, checked: true });
    expect(editRow(row(), { purchasedQuantity: 900 })).toEqual({ purchasedQuantity: 900, checked: true });
    expect(editRow(row({ purchasedQuantity: 700, checked: true }), { purchasedQuantity: 500 })).toEqual({ purchasedQuantity: 500, checked: false });
  });

  it('takes a tick on a row nobody typed in as "I have all of it"', () => {
    expect(editRow(row(), { checked: true })).toEqual({ purchasedQuantity: 700, checked: true });
    expect(editRow(row({ alreadyHaveQuantity: 0, purchasedQuantity: null }), { checked: true })).toEqual({ purchasedQuantity: 700, checked: true });
  });

  it('lets a row be closed at less than the need when the user said how much there is', () => {
    expect(editRow(row({ purchasedQuantity: 450 }), { checked: true })).toEqual({ purchasedQuantity: 450, checked: true });
    expect(editRow(row(), { purchasedQuantity: 450, checked: true })).toEqual({ purchasedQuantity: 450, checked: true });
  });

  it('takes an untick of a complete row as "I do not have it after all": back to what was at home', () => {
    expect(editRow(row({ purchasedQuantity: 700, checked: true }), { checked: false })).toEqual({ purchasedQuantity: 200, checked: false });
    expect(editRow(row({ purchasedQuantity: 900, checked: true }), { checked: false })).toEqual({ purchasedQuantity: 200, checked: false });
    expect(editRow(row({ alreadyHaveQuantity: 0, purchasedQuantity: 700, checked: true }), { checked: false })).toEqual({ purchasedQuantity: null, checked: false });
  });

  it('keeps the quantity of a row that was closed at less than the need when it is unticked', () => {
    expect(editRow(row({ purchasedQuantity: 450, checked: true }), { checked: false })).toEqual({ purchasedQuantity: 450, checked: false });
  });

  it('lets a quantity and a tick that disagree stand when both are given', () => {
    expect(editRow(row(), { purchasedQuantity: 900, checked: false })).toEqual({ purchasedQuantity: 900, checked: false });
  });

  it('leaves a row whose need the pantry covered at that when it is unticked', () => {
    expect(editRow(row({ alreadyHaveQuantity: 700, purchasedQuantity: 700, checked: true }), { checked: false })).toEqual({ purchasedQuantity: 700, checked: false });
  });

  it('clears the quantity and unticks when it is set to nothing', () => {
    expect(editRow(row({ purchasedQuantity: 700, checked: true }), { purchasedQuantity: null })).toEqual({ purchasedQuantity: null, checked: false });
  });

  it('changes nothing for an empty edit', () => {
    expect(editRow(row({ purchasedQuantity: 450 }), {})).toEqual({ purchasedQuantity: 450, checked: false });
  });
});

describe('what a row means for the pantry', () => {
  it('is nothing while the row is not ticked', () => {
    expect(intendedPantryEffect(row({ purchasedQuantity: 650 }))).toBe(0);
  });

  it('takes what the list counted as already at home once the row is ticked', () => {
    expect(intendedPantryEffect(row({ purchasedQuantity: 700, checked: true }))).toBe(-200);
  });

  it('adds what was bought beyond the need', () => {
    expect(intendedPantryEffect(row({ purchasedQuantity: 800, checked: true }))).toBe(-100);
    expect(intendedPantryEffect(row({ alreadyHaveQuantity: 0, purchasedQuantity: 1000, checked: true }))).toBe(300);
  });

  it('still takes the part at home when the row is closed at less than the need', () => {
    expect(intendedPantryEffect(row({ purchasedQuantity: 450, checked: true }))).toBe(-200);
  });
});

describe('what the user holds for the plan outside the pantry', () => {
  it('is what was bought, for a row that is not ticked', () => {
    expect(heldForPlan(row())).toBe(0);
    expect(heldForPlan(row({ purchasedQuantity: 500 }))).toBe(300);
    expect(heldForPlan(row({ alreadyHaveQuantity: 0, purchasedQuantity: null }))).toBe(0);
  });

  it('is the need that was met, for a ticked row: the part taken from the pantry included', () => {
    expect(heldForPlan(row({ purchasedQuantity: 700, checked: true }))).toBe(700);
    expect(heldForPlan(row({ purchasedQuantity: 900, checked: true }))).toBe(700);
    expect(heldForPlan(row({ purchasedQuantity: 450, checked: true }))).toBe(450);
  });
});

describe('removing a list', () => {
  it('returns everything obtained for a row when all of it is still in the kitchen', () => {
    // Ticked: 200 g came from the pantry, 500 g from the shop. All 700 g go to the pantry: 500 g more than it began with.
    expect(pantryEffectOnRemoval(row({ purchasedQuantity: 700, checked: true }), 1)).toBe(500);
    // With a surplus of 100 g, which is in the pantry already.
    expect(pantryEffectOnRemoval(row({ purchasedQuantity: 800, checked: true }), 1)).toBe(600);
    // Not ticked: the 300 g that were bought.
    expect(pantryEffectOnRemoval(row({ purchasedQuantity: 500 }), 1)).toBe(300);
    // Never touched: nothing.
    expect(pantryEffectOnRemoval(row(), 1)).toBe(0);
  });

  it('leaves the pantry as the row left it when the days of the list are over', () => {
    expect(pantryEffectOnRemoval(row({ purchasedQuantity: 700, checked: true }), 0)).toBe(-200);
    expect(pantryEffectOnRemoval(row({ purchasedQuantity: 800, checked: true }), 0)).toBe(-100);
    expect(pantryEffectOnRemoval(row({ purchasedQuantity: 500 }), 0)).toBe(0);
  });

  it('returns the share that belongs to the days still ahead', () => {
    expect(pantryEffectOnRemoval(row({ purchasedQuantity: 700, checked: true }), 0.5)).toBe(150);
  });
});

describe('the share of a list that is still ahead', () => {
  const date = (iso: string) => new Date(iso);

  it.each([
    ['2026-10-01', 1],
    ['2026-10-05', 1],
    ['2026-10-06', 6 / 7],
    ['2026-10-11', 1 / 7],
    ['2026-10-12', 0],
    ['2026-12-01', 0],
  ])('on %s, of a list for 5 to 11 October: %s', (today, share) => {
    expect(shareAhead(date('2026-10-05'), date('2026-10-11'), date(today))).toBeCloseTo(share, 10);
  });

  it('is nothing for a range that ends before it starts', () => {
    expect(shareAhead(date('2026-10-11'), date('2026-10-05'), date('2026-10-01'))).toBe(0);
  });
});
