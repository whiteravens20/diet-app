// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { DRAFT_CATALOGUE_SIZE, draftCatalogue } from './draft-catalogue.js';

interface Row {
  id: string;
  slug: string;
  category: string;
}

/** A catalogue of `perCategory` ingredients in each of `categories`. */
const catalogue = (categories: string[], perCategory: number): Row[] =>
  categories.flatMap((category) =>
    Array.from({ length: perCategory }, (_, index) => ({
      id: `${category}-${index}`,
      slug: `${category}-${String(index).padStart(3, '0')}`,
      category,
    })),
  );

const KINDS = ['dairy', 'fats_oils', 'fruits', 'grains', 'legumes', 'meat', 'vegetables'];
const slugs = (rows: Row[]): string[] => rows.map((row) => row.slug);

describe('the ingredients offered for a draft', () => {
  it('are the same for the same request, whatever order the catalogue arrives in', () => {
    const rows = catalogue(KINDS, 80);
    const reversed = [...rows].reverse();

    expect(slugs(draftCatalogue(rows, new Set(), 'profile-1:lunch'))).toEqual(
      slugs(draftCatalogue(reversed, new Set(), 'profile-1:lunch')),
    );
  });

  it('differ between requests when the catalogue is too large to offer whole', () => {
    const rows = catalogue(KINDS, 80);

    expect(slugs(draftCatalogue(rows, new Set(), 'profile-1:lunch'))).not.toEqual(
      slugs(draftCatalogue(rows, new Set(), 'profile-1:dinner')),
    );
  });

  it('never exceed the size of a prompt, and are the whole catalogue when it is small', () => {
    expect(draftCatalogue(catalogue(KINDS, 80), new Set(), 'seed')).toHaveLength(DRAFT_CATALOGUE_SIZE);

    const small = catalogue(KINDS, 3);
    expect(slugs(draftCatalogue(small, new Set(), 'seed')).sort()).toEqual(slugs(small).sort());
  });

  it('include every favourite, however large the catalogue', () => {
    const rows = catalogue(KINDS, 80);
    const favourites = new Set(['meat-79', 'grains-78', 'vegetables-77', 'dairy-76']);

    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const offered = new Set(draftCatalogue(rows, favourites, seed).map((row) => row.id));
      for (const id of favourites) expect(offered.has(id)).toBe(true);
    }
  });

  it('hold something of every category, in near-equal shares', () => {
    const rows = [...catalogue(KINDS, 80), ...catalogue(['spices'], 2)];
    const offered = draftCatalogue(rows, new Set(), 'seed');

    const perCategory = new Map<string, number>();
    for (const row of offered) perCategory.set(row.category, (perCategory.get(row.category) ?? 0) + 1);

    expect([...perCategory.keys()].sort()).toEqual([...KINDS, 'spices'].sort());
    // A category with two ingredients gives both; the others share the rest.
    expect(perCategory.get('spices')).toBe(2);
    const shares = KINDS.map((kind) => perCategory.get(kind)!);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
  });

  it('do not let many favourites crowd the list past its size', () => {
    const rows = catalogue(KINDS, 80);
    const favourites = new Set(rows.slice(0, 100).map((row) => row.id));

    expect(draftCatalogue(rows, favourites, 'seed')).toHaveLength(DRAFT_CATALOGUE_SIZE);
  });

  it('are listed by category, then by slug', () => {
    const offered = draftCatalogue(catalogue(KINDS, 80), new Set(['vegetables-5']), 'seed');
    const listed = offered.map((row) => `${row.category}/${row.slug}`);

    expect(listed).toEqual([...listed].sort());
  });
});
