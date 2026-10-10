// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Quantities as people read them.
 *
 * The engine works with exact numbers: 212.4 g of chicken, 3.2 eggs. Nobody
 * weighs out 212.4 g or buys 3.2 eggs, so everything that leaves the API to be
 * read goes through here once. The exact number stays what nutrition, the
 * pantry and every later calculation use.
 *
 *  - Grams and millilitres: to the nearest 5 above 10, to the nearest 1 up to
 *    10 (a 3 g pinch must not become 5 g or nothing).
 *  - An ingredient that is counted (`displayUnit`): in pieces of its own, to
 *    the nearest half. An amount too small to be half a piece stays in grams.
 *  - What one buys is rounded up: whole pieces, the next 5 g or 5 ml.
 *  - A quantity that is not zero is never shown as zero.
 */
import type { DisplayAmount, DisplayUnit, NaturalUnit, Unit } from '@diet-app/shared';
import { convertUnit, UnitConversionError, type ConvertibleIngredient } from './units.js';

/** An ingredient as the display rules need to know it. */
export type DisplayedIngredient = ConvertibleIngredient & {
  /** What a piece of it is called, when it is counted instead of weighed. */
  displayUnit: string | null;
};

/** Below this share of a piece an amount is shown by weight: "5 g onion", not "half an onion". */
const SMALLEST_PIECE = 0.25;

/** The noise of converting units: 3.0000000004 pieces are 3. */
const EPSILON = 1e-6;

const nearest = (value: number, step: number): number => Math.round(value / step) * step;
const up = (value: number, step: number): number => Math.ceil((value - EPSILON) / step) * step;
const down = (value: number, step: number): number => Math.floor((value + EPSILON) / step) * step;

/** The step grams and millilitres are counted in at this size. */
const massStep = (value: number): number => (value <= 10 ? 1 : 5);

function converted(quantity: number, unit: Unit, target: Unit, ingredient: ConvertibleIngredient): number | null {
  try {
    return convertUnit(quantity, unit, target, ingredient);
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return null;
  }
}

/** Whether the ingredient is one that is counted in pieces of its own. */
export function isCounted(ingredient: DisplayedIngredient): ingredient is DisplayedIngredient & { displayUnit: NaturalUnit } {
  return ingredient.displayUnit !== null && converted(1, 'piece', ingredient.canonicalUnit, ingredient) !== null;
}

/** A quantity of at least one step: what is there is never shown as nothing. */
const shown = (value: number, rounded: number, step: number): number => (value > EPSILON && rounded < step ? step : rounded);

/** An amount to cook with: a line of a recipe, or what a planned meal takes. */
export function displayAmount(quantity: number, unit: Unit, ingredient: DisplayedIngredient): DisplayAmount {
  if (isCounted(ingredient)) {
    const pieces = converted(quantity, unit, 'piece', ingredient);
    if (pieces !== null && pieces >= SMALLEST_PIECE) {
      return { quantity: nearest(pieces, 0.5), unit: ingredient.displayUnit };
    }
  }
  const amount = converted(quantity, unit, ingredient.canonicalUnit, ingredient);
  // What cannot be converted is shown as it was written.
  const [value, inUnit] = amount === null ? [quantity, unit] : [amount, ingredient.canonicalUnit];
  if (inUnit === 'piece') return { quantity: shown(value, nearest(value, 0.5), 0.5), unit: 'piece' };
  const step = massStep(value);
  return { quantity: shown(value, nearest(value, step), 1), unit: inUnit };
}

/** What a pantry row holds: in the row's own unit, a piece called what the ingredient calls it. */
export function displayStock(quantity: number, unit: Unit, ingredient: DisplayedIngredient): DisplayAmount {
  if (unit === 'piece') {
    const name: DisplayUnit = isCounted(ingredient) ? ingredient.displayUnit : 'piece';
    return { quantity: shown(quantity, nearest(quantity, 0.5), 0.5), unit: name };
  }
  return { quantity: shown(quantity, nearest(quantity, 1), 1), unit };
}

/** The unit a shopping row of the ingredient is counted in, and what to call it. */
export function shoppingUnit(ingredient: DisplayedIngredient): { unit: Unit; displayUnit: DisplayUnit } {
  if (isCounted(ingredient)) return { unit: 'piece', displayUnit: ingredient.displayUnit };
  return { unit: ingredient.canonicalUnit, displayUnit: ingredient.canonicalUnit };
}

/** How much to buy for a need of `quantity` in a shopping row's unit: rounded up to what one buys. */
export function quantityToBuy(quantity: number, unit: Unit): number {
  if (quantity <= EPSILON) return 0;
  return unit === 'piece' ? up(quantity, 1) : up(quantity, massStep(quantity));
}

/**
 * How much of a need the pantry may be counted on for: rounded down to what
 * one counts, so that a list never claims a fraction of an egg, and never
 * more than the need.
 */
export function quantityToClaim(available: number, unit: Unit, need: number): number {
  const counted = unit === 'piece' ? down(available, 1) : down(available, massStep(available));
  return Math.max(0, Math.min(counted, need));
}
