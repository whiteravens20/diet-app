// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The units a quantity is kept in, and those of them an ingredient can be
 * kept in. The schema that checks a unit is built on this list (`enums.ts`).
 *
 * This file needs nothing else of the contract. A page that only has to know
 * them takes them from `@diet-app/shared/units`, and loads no schema and no
 * validation library with them.
 */

/** The units a quantity is kept in, and the engine converts everything into. */
export const UNITS = ['g', 'ml', 'piece'] as const;

/**
 * The units an ingredient can be kept in: those the API converts into the unit
 * it is measured in. Pieces go by the weight of a piece, grams and millilitres
 * by the density, and pieces of what is measured in millilitres, or the other
 * way round, by both. A row in any other unit is refused with
 * `UNIT_NOT_CONVERTIBLE`.
 */
export function pantryUnits(ingredient: {
  canonicalUnit: (typeof UNITS)[number];
  gramsPerPiece: number | null;
  density: number | null;
}): (typeof UNITS)[number][] {
  const weighsPerPiece = (ingredient.gramsPerPiece ?? 0) > 0;
  const weighsPerMillilitre = (ingredient.density ?? 0) > 0;
  return UNITS.filter((unit) => {
    if (unit === ingredient.canonicalUnit) return true;
    if (unit === 'piece' || ingredient.canonicalUnit === 'piece') {
      return weighsPerPiece && (unit === 'g' || ingredient.canonicalUnit === 'g' || weighsPerMillilitre);
    }
    return weighsPerMillilitre;
  });
}
