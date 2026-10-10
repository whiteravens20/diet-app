// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

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
  return convertUnit(quantity, unit, ingredient.canonicalUnit, ingredient);
}

/**
 * Convert `quantity` of an ingredient from one unit into another. Throws when
 * the factor the conversion needs is missing, or is not a positive number: a
 * density of zero would turn every weight into an infinite volume.
 */
export function convertUnit(
  quantity: number,
  unit: Unit,
  target: Unit,
  ingredient: Pick<ConvertibleIngredient, 'gramsPerPiece' | 'density'>,
): number {
  if (unit === target) return quantity;

  // piece → g/ml
  if (unit === 'piece') {
    const grams = quantity * gramsPerPiece(ingredient, 'from piece');
    return target === 'g' ? grams : gramsToMl(grams, ingredient);
  }

  // g ↔ ml
  if (unit === 'g' && target === 'ml') return gramsToMl(quantity, ingredient);
  if (unit === 'ml' && target === 'g') return mlToGrams(quantity, ingredient);

  // g/ml → piece
  if (target === 'piece') {
    const grams = unit === 'g' ? quantity : mlToGrams(quantity, ingredient);
    return grams / gramsPerPiece(ingredient, 'to piece');
  }

  // Unreachable with the 3-value Unit enum (every g/ml/piece pair is handled
  // above) — kept as a defensive guard if a new unit is ever added.
  /* v8 ignore next */
  throw new UnitConversionError(`unsupported conversion ${unit} → ${target}`);
}

function gramsPerPiece(ingredient: Pick<ConvertibleIngredient, 'gramsPerPiece'>, direction: string): number {
  if (ingredient.gramsPerPiece == null || !(ingredient.gramsPerPiece > 0)) {
    throw new UnitConversionError(`a positive gramsPerPiece is required to convert ${direction}`);
  }
  return ingredient.gramsPerPiece;
}

function density(ingredient: Pick<ConvertibleIngredient, 'density'>, direction: string): number {
  if (ingredient.density == null || !(ingredient.density > 0)) {
    throw new UnitConversionError(`a positive density is required (${direction})`);
  }
  return ingredient.density;
}

function gramsToMl(grams: number, ingredient: Pick<ConvertibleIngredient, 'density'>): number {
  return grams / density(ingredient, 'g→ml');
}

function mlToGrams(ml: number, ingredient: Pick<ConvertibleIngredient, 'density'>): number {
  return ml * density(ingredient, 'ml→g');
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
