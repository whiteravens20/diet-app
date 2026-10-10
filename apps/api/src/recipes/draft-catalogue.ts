// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';

/** How many ingredients one draft prompt offers: enough to cook from, small enough to read. */
export const DRAFT_CATALOGUE_SIZE = 60;

/**
 * The ingredients a model is offered for one draft, out of all that the
 * profile may eat.
 *
 * The profile's favourites come first, so asking for them cannot be defeated
 * by the cut. The places left are dealt out one category at a time, so that
 * whatever the size of the catalogue there is something of every kind on the
 * table: a protein, a grain, a vegetable, a fat.
 *
 * Which ingredients of a category are dealt depends on `seed` alone. The same
 * request therefore sees the same list every time, and different requests see
 * different corners of a catalogue too large to offer whole.
 *
 * The result is in category and slug order, which is how the prompt lists it.
 */
export function draftCatalogue<T extends { id: string; slug: string; category: string }>(
  eligible: readonly T[],
  favouriteIds: ReadonlySet<string>,
  seed: string,
  size: number = DRAFT_CATALOGUE_SIZE,
): T[] {
  const bySlug = (a: T, b: T): number => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const chosen = eligible.filter((ingredient) => favouriteIds.has(ingredient.id)).sort(bySlug).slice(0, size);

  const rank = (ingredient: T): string => createHash('sha256').update(`${seed}:${ingredient.slug}`).digest('hex');
  const piles = new Map<string, { ingredient: T; rank: string }[]>();
  for (const ingredient of eligible) {
    if (favouriteIds.has(ingredient.id)) continue;
    const pile = piles.get(ingredient.category) ?? [];
    pile.push({ ingredient, rank: rank(ingredient) });
    piles.set(ingredient.category, pile);
  }
  const categories = [...piles.keys()].sort();
  for (const pile of piles.values()) pile.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));

  for (let round = 0; chosen.length < size; round += 1) {
    let dealt = false;
    for (const category of categories) {
      const next = piles.get(category)![round];
      if (!next || chosen.length >= size) continue;
      chosen.push(next.ingredient);
      dealt = true;
    }
    if (!dealt) break;
  }

  return chosen.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : bySlug(a, b)));
}
