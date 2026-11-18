// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * How what goes into the freezer is split into portions, each a package of its own in the pantry.
 *
 * This file needs nothing else of the contract. The pantry's page takes it from `@diet-app/shared/portions`, and no
 * other page loads it.
 */
import type { UNITS } from './units.js';

/**
 * The most portions one freezing is split into: each a package of its own in the pantry, which holds at most
 * `MAX_PANTRY_ROWS` rows.
 */
export const MAX_PORTIONS = 10;

/** Quantities closer than this are the same quantity: the noise of converting units. */
const PORTION_EPSILON = 1e-6;

const toMillionths = (quantity: number): number => Math.round(quantity * 1e6) / 1e6;

/**
 * `quantity` of `unit` split into `portions` parts, for packages of the freezer: what is counted in whole pieces as
 * evenly as they go, the larger parts first (6 in 4: 2, 2, 1, 1) and a part of a piece with the last; anything else in
 * equal parts, what rounding leaves with the last. Null where a part would hold less than one of the unit.
 */
export function portionsOf(
  quantity: number,
  unit: (typeof UNITS)[number],
  portions: number,
): number[] | null {
  if (portions <= 1) return [quantity];
  if (unit !== 'piece') {
    const each = toMillionths(quantity / portions);
    if (each < 1) return null;
    return Array.from({ length: portions }, (_, at) =>
      at === portions - 1 ? toMillionths(quantity - each * (portions - 1)) : each,
    );
  }
  const whole = Math.floor(quantity + PORTION_EPSILON);
  if (whole < portions) return null;
  const base = Math.floor(whole / portions);
  const more = whole - base * portions;
  return Array.from({ length: portions }, (_, at) =>
    toMillionths(base + (at < more ? 1 : 0) + (at === portions - 1 ? quantity - whole : 0)),
  );
}
