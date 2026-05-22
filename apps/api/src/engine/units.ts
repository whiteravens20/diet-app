/**
 * Deterministic unit conversion.
 *
 * The curated database stores nutrition per 100 canonical units (g / ml / piece).
 * Recipes may express quantities in any unit; this module converts everything to
 * the ingredient's canonical unit so totals and nutrition are reproducible.
 */
import type { Unit } from '@diet-app/shared';

export interface ConvertibleIngredient {
  canonicalUnit: Unit;
  /** g per piece — required to convert `piece` ↔ mass. */
  gramsPerPiece: number | null;
  /** g per ml — required to convert `ml` ↔ `g`. */
  density: number | null;
}

export class UnitConversionError extends Error {}

/**
 * Convert `quantity` of `unit` into the ingredient's canonical unit.
 * Throws when a conversion needs density / gramsPerPiece that is not present —
 * callers surface this as a data-quality error rather than guessing.
 */
export function toCanonical(
  quantity: number,
  unit: Unit,
  ingredient: ConvertibleIngredient,
): number {
  const target = ingredient.canonicalUnit;
  if (unit === target) return quantity;

  // piece → g/ml
  if (unit === 'piece') {
    if (ingredient.gramsPerPiece == null) {
      throw new UnitConversionError('gramsPerPiece required to convert from piece');
    }
    const grams = quantity * ingredient.gramsPerPiece;
    return target === 'g' ? grams : gramsToMl(grams, ingredient);
  }

  // g ↔ ml
  if (unit === 'g' && target === 'ml') return gramsToMl(quantity, ingredient);
  if (unit === 'ml' && target === 'g') return mlToGrams(quantity, ingredient);

  // g/ml → piece
  if (target === 'piece') {
    if (ingredient.gramsPerPiece == null) {
      throw new UnitConversionError('gramsPerPiece required to convert to piece');
    }
    const grams = unit === 'g' ? quantity : mlToGrams(quantity, ingredient);
    return grams / ingredient.gramsPerPiece;
  }

  throw new UnitConversionError(`unsupported conversion ${unit} → ${target}`);
}

function gramsToMl(grams: number, ingredient: ConvertibleIngredient): number {
  if (ingredient.density == null) throw new UnitConversionError('density required (g→ml)');
  return grams / ingredient.density;
}

function mlToGrams(ml: number, ingredient: ConvertibleIngredient): number {
  if (ingredient.density == null) throw new UnitConversionError('density required (ml→g)');
  return ml * ingredient.density;
}

/** Nutrition contribution of `canonicalQuantity` units of an ingredient. */
export function nutritionFor(
  canonicalQuantity: number,
  per100: { calories: number; protein: number; fat: number; carbs: number },
): { calories: number; protein: number; fat: number; carbs: number } {
  const factor = canonicalQuantity / 100;
  return {
    calories: per100.calories * factor,
    protein: per100.protein * factor,
    fat: per100.fat * factor,
    carbs: per100.carbs * factor,
  };
}
