import { describe, expect, it } from 'vitest';
import {
  type PlanIngredientLine,
  aggregateShoppingList,
  toBuyQuantity,
} from './shopping.js';
import type { EngineIngredient } from './substitution.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
function ing(over: Partial<EngineIngredient> & Pick<EngineIngredient, 'id' | 'name'>): EngineIngredient {
  return {
    category: 'vegetables',
    canonicalUnit: 'g',
    caloriesPer100: 0,
    proteinPer100: 0,
    fatPer100: 0,
    carbsPer100: 0,
    gramsPerPiece: null,
    density: null,
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

const DB = new Map<string, EngineIngredient>(
  [tomato, broccoli, apple, avocado, milk].map((i) => [i.id, i]),
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

  it('rounds the canonical total to one decimal', () => {
    // 1 piece tomato = 120 g; a g line of 0.04 keeps it on the 0.1 grid.
    const groups = aggregateShoppingList(
      [line({ ingredientId: 't', quantity: 100.04, unit: 'g' })],
      DB,
    );
    expect(groups[0].items[0].totalQuantity).toBe(100);
  });

  it('estimates calories from the per-100 macros and rounds', () => {
    const groups = aggregateShoppingList([line({ ingredientId: 't', quantity: 200 })], DB);
    // 200 g tomato at 18 kcal/100 g = 36 kcal
    expect(groups[0].items[0].estimatedCalories).toBe(36);
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

  it('rounds the remainder to one decimal', () => {
    expect(toBuyQuantity(10.27, 0)).toBe(10.3);
  });
});
