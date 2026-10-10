// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';
import type { Unit } from '@diet-app/shared';

/**
 * A stable name for what a recipe is made of: the same for two recipes with
 * the same ingredients in the same amounts, for the same meals and servings,
 * whoever wrote them and whatever they are called.
 *
 * It covers the ingredient lines (slug, unit, quantity), the meal types and
 * the servings. The prose is left out on purpose: a title or a step can be
 * polished without the recipe becoming another one. So is everything that is
 * worked out from the ingredients (nutrition, allergens, diets): it adds
 * nothing, and it would change the name whenever a rule or the ingredient
 * table changed.
 *
 * The name depends on the lines as they are written and on nothing else, so
 * two instances agree on it without sharing a database. A line in pieces and
 * the same amount in grams are therefore two different names.
 */
export interface FingerprintInput {
  ingredients: readonly { slug: string; quantity: number; unit: Unit }[];
  mealTypes: readonly string[];
  servings: number;
}

/** SHA-256 of the canonical form, as 64 hex characters. */
export function computeFingerprint(input: FingerprintInput): string {
  // An ingredient listed twice in one unit is that ingredient once, with the
  // sum: oil for frying and oil for the dressing make the same recipe as the
  // total in one line, in whichever order the lines stand.
  const totals = new Map<string, { slug: string; unit: Unit; quantity: number }>();
  for (const line of input.ingredients) {
    const key = `${line.slug}\u0000${line.unit}`;
    const total = totals.get(key);
    if (total) total.quantity += line.quantity;
    else totals.set(key, { slug: line.slug, unit: line.unit, quantity: line.quantity });
  }
  const ingredients = [...totals.values()]
    .map((line) => [line.slug, line.unit, roundForFingerprint(line.quantity)] as const)
    // By code unit, not by locale: the order must not depend on where it runs.
    .sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));

  const canonical = {
    ingredients,
    mealTypes: [...new Set(input.mealTypes)].sort(compare),
    servings: input.servings,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * To a tenth of a unit, so that the noise of floating-point arithmetic does
 * not make two recipes of one: 200.00000001 g is 200 g, 200.1 g is not.
 */
function roundForFingerprint(quantity: number): number {
  return Math.round(quantity * 10) / 10;
}
