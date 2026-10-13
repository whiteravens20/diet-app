// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Meat and fish are bought raw: a recipe weighs them raw and a shopping list
 * buys them raw, so the catalogue gives the figures of the raw food. Cooking
 * drives water out of them: roasted chicken breast holds 31 g of protein and
 * 165 kcal in a hundred grams where the raw one holds 22.5 g and 120 kcal,
 * and a dish counted on the cooked figures would be said to hold a third more
 * of both than it has.
 *
 * Raw meat and fish hold no more than about 24 g of protein in a hundred
 * grams, and a drained tin of tuna under twenty. What is sold in a pack and
 * holds more is cooked or dried.
 */
export const MOST_PROTEIN_OF_RAW_MEAT = 25;

interface Bought {
  slug: string;
  category: string;
  packSize?: number | null;
  proteinPer100: number;
}

/** The meat and fish of a catalogue whose figures can only be those of the cooked food, by slug. */
export function givenAsCookedMeat(ingredients: readonly Bought[]): string[] {
  return ingredients
    .filter((ingredient) => ingredient.category === 'meat' || ingredient.category === 'fish')
    .filter((ingredient) => ingredient.packSize != null && ingredient.proteinPer100 > MOST_PROTEIN_OF_RAW_MEAT)
    .map((ingredient) => ingredient.slug);
}
