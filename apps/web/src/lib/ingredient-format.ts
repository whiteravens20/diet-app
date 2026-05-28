import type { RecipeIngredient } from '@diet-app/shared';

/**
 * Round a mass/volume amount to a kitchen-realistic increment. Above 10 the
 * nearest 5 (so 213 → 215, 212 → 210, never "213 g chicken"); at or below
 * 10 the nearest 1 (so a 3 g pinch of salt isn't rounded down to zero).
 */
export function roundKitchenAmount(value: number): number {
  if (value <= 10) return Math.round(value);
  return Math.round(value / 5) * 5;
}

/**
 * Render a recipe ingredient as a concrete shopping/cooking amount.
 *
 * Pieces are always converted to grams when the ingredient carries a
 * `gramsPerPiece` weight — fractional pieces ("0.75 banana") are confusing,
 * grams aren't. Falls back to the raw unit only when no conversion is known.
 *
 * @param scale  multiplier (e.g. plannedServings / recipeServings); defaults to 1.
 */
export function formatIngredientAmount(
  i: Pick<RecipeIngredient, 'quantity' | 'unit' | 'gramsPerPiece'>,
  scale = 1,
): string {
  const qty = i.quantity * scale;
  if (i.unit === 'piece' && i.gramsPerPiece) {
    return `${roundKitchenAmount(qty * i.gramsPerPiece)} g`;
  }
  if (i.unit === 'piece') {
    // Fallback: no per-piece weight in the curated DB — keep pieces, but
    // round to a quarter so we never show seven decimal places.
    const rounded = Math.round(qty * 4) / 4;
    return `${rounded} ${rounded === 1 ? 'piece' : 'pieces'}`;
  }
  return `${roundKitchenAmount(qty)} ${i.unit}`;
}
