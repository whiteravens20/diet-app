// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A grain or a pulse that keeps in its pack is bought dry: a recipe weighs
 * it dry and a shopping list buys it dry, so the catalogue gives the figures
 * of the dry food. The cooked food holds about a third of them in a hundred
 * grams, and a dish counted on those would be said to hold a third of the
 * energy it has.
 *
 * What is canned or fresh is marked as not keeping once opened and is left
 * alone. What keeps and is not dry says so here, with the reason.
 */
export const LEAST_ENERGY_OF_A_DRY_STAPLE = 300;

/** Grains and pulses that keep in their pack and are not dry, each with what it is. */
const KEEPS_BUT_IS_NOT_DRY: Readonly<Record<string, string>> = {
  edamame: 'sold frozen',
};

interface Staple {
  slug: string;
  category: string;
  packSize?: number | null;
  perishable?: boolean | null;
  caloriesPer100: number;
}

/** The grains and pulses of a catalogue whose figures can only be those of the cooked food, by slug. */
export function givenAsCooked(ingredients: readonly Staple[]): string[] {
  return ingredients
    .filter((ingredient) => ingredient.category === 'grains' || ingredient.category === 'legumes')
    .filter(
      (ingredient) =>
        ingredient.packSize != null &&
        !ingredient.perishable &&
        !(ingredient.slug in KEEPS_BUT_IS_NOT_DRY),
    )
    .filter((ingredient) => ingredient.caloriesPer100 < LEAST_ENERGY_OF_A_DRY_STAPLE)
    .map((ingredient) => ingredient.slug);
}
