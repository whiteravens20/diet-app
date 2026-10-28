// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The units a quantity is kept in, and the energy a gram of each
 * macronutrient gives. The schema that checks a unit is built on this list
 * (`enums.ts`).
 *
 * This file needs nothing else of the contract. A page that only has to know
 * them takes them from `@diet-app/shared/units`, and loads no schema and no
 * validation library with them.
 */

/** The units a quantity is kept in, and the engine converts everything into. */
export const UNITS = ['g', 'ml', 'piece'] as const;

/** kcal in 1 g of each macronutrient (Atwater factors): how a target is split into grams, and grams into shares of energy. */
export const KCAL_PER_GRAM = { protein: 4, fat: 9, carbs: 4 } as const;
