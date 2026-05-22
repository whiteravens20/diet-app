/**
 * Deterministic shopping-list aggregation.
 *
 * Merges every ingredient line across the selected plan range, normalises units
 * to each ingredient's canonical unit, groups by product category and applies
 * "already have at home" deductions.
 */
import type { ProductCategory, Unit } from '@diet-app/shared';
import { nutritionFor, toCanonical } from './units.js';
import type { EngineIngredient } from './substitution.js';

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
  totalQuantity: number;
  unit: Unit;
  estimatedCalories: number;
}

export interface AggregatedGroup {
  category: ProductCategory;
  items: AggregatedItem[];
}

/** Canonical ordering for category groups in the UI. */
const CATEGORY_ORDER: ProductCategory[] = [
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
 * Aggregate plan lines into category-grouped, unit-normalised items.
 * `ingredients` must contain a record for every referenced ingredientId.
 */
export function aggregateShoppingList(
  lines: PlanIngredientLine[],
  ingredients: Map<string, EngineIngredient>,
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
  for (const [ingredientId, totalQuantity] of totals) {
    const ing = ingredients.get(ingredientId)!;
    const rounded = round1(totalQuantity);
    items.push({
      ingredientId,
      name: ing.name,
      category: ing.category,
      totalQuantity: rounded,
      unit: ing.canonicalUnit,
      estimatedCalories: Math.round(
        nutritionFor(rounded, {
          calories: ing.caloriesPer100,
          protein: ing.proteinPer100,
          fat: ing.fatPer100,
          carbs: ing.carbsPer100,
        }).calories,
      ),
    });
  }

  return CATEGORY_ORDER.map((category) => ({
    category,
    items: items
      .filter((i) => i.category === category)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.items.length > 0);
}

/** to-buy quantity after deducting what the user already has, floored at 0. */
export function toBuyQuantity(total: number, alreadyHave: number): number {
  return Math.max(0, round1(total - alreadyHave));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
