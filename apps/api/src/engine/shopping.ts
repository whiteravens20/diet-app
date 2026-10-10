// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Deterministic shopping-list aggregation, and what a row of a list means for
 * the pantry.
 *
 * Merges every ingredient line across the selected plan range, counts each
 * ingredient in the unit it is bought in (pieces for what is counted, the
 * canonical unit otherwise), rounds the need up to what one buys and groups by
 * product category.
 */
import type { DisplayUnit, ProductCategory, Unit } from '@diet-app/shared';
import { quantityToBuy, shoppingUnit } from './display.js';
import { convertUnit, nutritionFor, toCanonical } from './units.js';
import type { EngineIngredient } from './substitution.js';

/** An ingredient as a shopping list needs to know it. */
export type ShoppingIngredient = EngineIngredient & {
  /** What a piece of it is called, when it is counted instead of weighed. */
  displayUnit: string | null;
};

/** One ingredient line drawn from a planned meal. */
export interface PlanIngredientLine {
  ingredientId: string;
  quantity: number;
  unit: Unit;
  /** Recipe-level servings vs. servings actually planned, used to scale. */
  recipeServings: number;
  plannedServings: number;
}

export interface AggregatedItem {
  ingredientId: string;
  name: string;
  category: ProductCategory;
  /** The need in `unit`, rounded up to what one buys. */
  totalQuantity: number;
  /** Pieces for an ingredient that is counted, its canonical unit otherwise. */
  unit: Unit;
  /** What to call `unit` when the row is shown. */
  displayUnit: DisplayUnit;
  /** From the exact need, before rounding. */
  estimatedCalories: number;
}

export interface AggregatedGroup {
  category: ProductCategory;
  items: AggregatedItem[];
}

/** The order of the aisles: the order groups are shown in, on every read. */
export const CATEGORY_ORDER: readonly ProductCategory[] = [
  'vegetables',
  'fruits',
  'meat',
  'fish',
  'dairy',
  'grains',
  'legumes',
  'nuts_seeds',
  'fats_oils',
  'spices',
  'pantry',
  'beverages',
  'other',
];

/**
 * Aggregate plan lines into category-grouped items, each in the unit its
 * ingredient is bought in and rounded up to what one buys: 3.2 eggs are four
 * eggs, 212.4 g of chicken are 215 g. `ingredients` must contain a record for
 * every referenced ingredientId.
 */
export function aggregateShoppingList(
  lines: PlanIngredientLine[],
  ingredients: Map<string, ShoppingIngredient>,
): AggregatedGroup[] {
  const totals = new Map<string, number>(); // ingredientId → canonical quantity

  for (const line of lines) {
    const ing = ingredients.get(line.ingredientId);
    if (!ing) throw new Error(`unknown ingredient ${line.ingredientId}`);
    const scale = line.recipeServings > 0 ? line.plannedServings / line.recipeServings : 1;
    const canonical = toCanonical(line.quantity * scale, line.unit, ing);
    totals.set(line.ingredientId, (totals.get(line.ingredientId) ?? 0) + canonical);
  }

  const items: AggregatedItem[] = [];
  for (const [ingredientId, need] of totals) {
    const ing = ingredients.get(ingredientId)!;
    const { unit, displayUnit } = shoppingUnit(ing);
    items.push({
      ingredientId,
      name: ing.name,
      category: ing.category,
      totalQuantity: quantityToBuy(convertUnit(need, ing.canonicalUnit, unit, ing), unit),
      unit,
      displayUnit,
      estimatedCalories: Math.round(
        nutritionFor(need, {
          calories: ing.caloriesPer100,
          protein: ing.proteinPer100,
          fat: ing.fatPer100,
          carbs: ing.carbsPer100,
        }).calories,
      ),
    });
  }

  return groupByAisle(items);
}

/** Items under their category, the categories in aisle order, the items by name. */
export function groupByAisle<T extends { category: ProductCategory; name: string }>(
  items: readonly T[],
): { category: ProductCategory; items: T[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: items.filter((i) => i.category === category).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length > 0);
}

/** to-buy quantity after deducting what the user already has, floored at 0. */
export function toBuyQuantity(total: number, alreadyHave: number): number {
  return Math.max(0, clean(total - alreadyHave));
}

/** A shopping row as far as the pantry is concerned. All quantities in the row's unit. */
export interface ShoppingRowState {
  totalQuantity: number;
  /** What the list took as already at home when it was made. */
  alreadyHaveQuantity: number;
  /** Everything the user has for the row, the part already at home included. Null: not edited. */
  purchasedQuantity: number | null;
  checked: boolean;
}

/**
 * What a row becomes when the user edits it. The quantity ticks the row by
 * itself: reaching the need ticks it, falling below unticks it. A tick given
 * explicitly wins, so that a row can be closed at less than the need (the shop
 * had no more).
 *
 * A tick or an untick given alone says how much there is as well. Ticking a
 * row whose quantity was never touched means "I have all of it": the quantity
 * becomes the need. Unticking a row whose quantity says it is complete means
 * "I do not, after all": the quantity goes back to what was at home.
 */
export function editRow(
  row: ShoppingRowState,
  patch: { purchasedQuantity?: number | null; checked?: boolean },
): Pick<ShoppingRowState, 'purchasedQuantity' | 'checked'> {
  const purchased = patch.purchasedQuantity !== undefined ? patch.purchasedQuantity : row.purchasedQuantity;
  const reachesNeed = (purchased ?? 0) >= row.totalQuantity;
  const checked = patch.checked ?? (patch.purchasedQuantity !== undefined ? reachesNeed : row.checked);
  if (patch.purchasedQuantity === undefined && patch.checked !== undefined) {
    const atHome = row.alreadyHaveQuantity > 0 ? row.alreadyHaveQuantity : null;
    if (checked && (purchased === null || purchased === row.alreadyHaveQuantity)) return { purchasedQuantity: row.totalQuantity, checked };
    if (!checked && reachesNeed) return { purchasedQuantity: atHome, checked };
  }
  return { purchasedQuantity: purchased, checked };
}

/**
 * The net effect a row means to have on the pantry, in the row's unit. Ticked:
 * what was bought beyond the need enters the pantry, and what the list counted
 * as already at home leaves it, because the plan now uses it. Unticked: none.
 */
export function intendedPantryEffect(row: ShoppingRowState): number {
  if (!row.checked) return 0;
  const surplus = Math.max(0, (row.purchasedQuantity ?? row.totalQuantity) - row.totalQuantity);
  return clean(surplus - row.alreadyHaveQuantity);
}

const clean = (n: number): number => Math.round(n * 1e6) / 1e6;
