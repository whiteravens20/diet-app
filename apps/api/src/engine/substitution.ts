/**
 * Deterministic ingredient substitution.
 *
 * Replaces one ingredient with another while holding calories as constant as
 * possible, then reports the macro delta. Honours allergen / exclusion / diet
 * constraints — an invalid swap is returned with `valid: false`, never applied
 * silently.
 */
import type { Allergen, DietType, Macros, Nutrition, ProductCategory, Unit } from '@diet-app/shared';
import { nutritionFor, toCanonical, type ConvertibleIngredient } from './units.js';

export interface EngineIngredient extends ConvertibleIngredient {
  id: string;
  name: string;
  category: ProductCategory;
  canonicalUnit: Unit;
  caloriesPer100: number;
  proteinPer100: number;
  fatPer100: number;
  carbsPer100: number;
  allergens: Allergen[];
  dietCompatibility: DietType[];
}

export interface SubstitutionConstraints {
  dietType: DietType;
  allergens: Allergen[];
  excludedIngredientIds: string[];
}

export interface SubstitutionResult {
  before: Nutrition;
  after: Nutrition;
  calorieDelta: number;
  macroDelta: Macros;
  /** Quantity of the replacement, in its own canonical unit. */
  adjustedQuantity: number;
  adjustedUnit: Unit;
  explanation: string;
  valid: boolean;
}

function per100(i: EngineIngredient) {
  return {
    calories: i.caloriesPer100,
    protein: i.proteinPer100,
    fat: i.fatPer100,
    carbs: i.carbsPer100,
  };
}

/**
 * Substitute `from` → `to` for a recipe line of `quantity`/`unit`.
 * The replacement quantity is scaled so calories match the original; when the
 * replacement has zero calories the original mass is kept unchanged.
 */
export function substituteIngredient(
  from: EngineIngredient,
  to: EngineIngredient,
  quantity: number,
  unit: Unit,
  constraints: SubstitutionConstraints,
): SubstitutionResult {
  const fromCanonical = toCanonical(quantity, unit, from);
  const before = withCalories(nutritionFor(fromCanonical, per100(from)));

  // Scale the replacement to match the original calories.
  const toCanonicalQty =
    to.caloriesPer100 > 0
      ? (before.calories / to.caloriesPer100) * 100
      : fromCanonical;
  const after = withCalories(nutritionFor(toCanonicalQty, per100(to)));

  const violations = constraintViolations(to, constraints);
  const valid = violations.length === 0;

  return {
    before,
    after,
    calorieDelta: round(after.calories - before.calories),
    macroDelta: {
      protein: round(after.protein - before.protein),
      fat: round(after.fat - before.fat),
      carbs: round(after.carbs - before.carbs),
    },
    adjustedQuantity: round1(toCanonicalQty),
    adjustedUnit: to.canonicalUnit,
    explanation: valid
      ? `${round1(toCanonicalQty)} ${to.canonicalUnit} of ${to.name} matches the ` +
        `${before.calories} kcal of ${quantity} ${unit} ${from.name}.`
      : `Cannot substitute with ${to.name}: ${violations.join('; ')}.`,
    valid,
  };
}

/** Collect every reason a candidate ingredient is disallowed. */
export function constraintViolations(
  candidate: EngineIngredient,
  c: SubstitutionConstraints,
): string[] {
  const reasons: string[] = [];
  const clashing = candidate.allergens.filter((a) => c.allergens.includes(a));
  if (clashing.length) reasons.push(`contains allergen(s) ${clashing.join(', ')}`);
  if (c.excludedIngredientIds.includes(candidate.id)) reasons.push('ingredient is excluded');
  if (
    c.dietType !== 'custom' &&
    candidate.dietCompatibility.length > 0 &&
    !candidate.dietCompatibility.includes(c.dietType)
  ) {
    reasons.push(`not compatible with ${c.dietType} diet`);
  }
  return reasons;
}

function withCalories(m: { calories: number; protein: number; fat: number; carbs: number }): Nutrition {
  return {
    calories: round(m.calories),
    protein: round(m.protein),
    fat: round(m.fat),
    carbs: round(m.carbs),
  };
}

const round = (n: number): number => Math.round(n);
const round1 = (n: number): number => Math.round(n * 10) / 10;
