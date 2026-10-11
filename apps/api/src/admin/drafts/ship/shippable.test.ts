// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { shippableIngredientName, shippableRecipe, sortForShipping, type RecipeDraftContent } from './shippable.js';

const draft = (over: Partial<RecipeDraftContent> = {}): RecipeDraftContent => ({
  slug: 'oat-bowl',
  titles: { en: ' Oat  bowl ', pl: 'Owsianka' },
  descriptions: { en: 'Oats with a banana.', pl: 'Płatki z bananem.' },
  steps: { en: ['Warm the drink.', 'Stir.'], pl: ['Podgrzej napój.', 'Wymieszaj.'] },
  locales: ['en', 'pl'],
  servings: 1,
  mealTypes: ['breakfast'],
  prepMinutes: 5,
  cookMinutes: 5,
  difficulty: 'easy',
  ingredientsJson: [
    { slug: 'rolled-oats', quantity: 60, unit: 'g', note: null },
    { slug: 'banana', quantity: 120, unit: 'g' },
  ],
  ...over,
});

describe('a recipe draft that is about to ship', () => {
  it('ships as the row the data files hold, with its text made plain', () => {
    expect(shippableRecipe(draft())).toEqual({
      ok: true,
      content: {
        slug: 'oat-bowl',
        title: { en: 'Oat bowl', pl: 'Owsianka' },
        description: { en: 'Oats with a banana.', pl: 'Płatki z bananem.' },
        servings: 1,
        mealTypes: ['breakfast'],
        prepMinutes: 5,
        cookMinutes: 5,
        difficulty: 'easy',
        ingredients: [
          { slug: 'rolled-oats', quantity: 60, unit: 'g', note: null },
          { slug: 'banana', quantity: 120, unit: 'g', note: null },
        ],
        steps: { en: ['Warm the drink.', 'Stir.'], pl: ['Podgrzej napój.', 'Wymieszaj.'] },
      },
    });
  });

  it('ships the languages it was reviewed in and no other', () => {
    const result = shippableRecipe(draft({ locales: ['en'], titles: { en: 'Oat bowl', pl: 'Nobody approved this' } }));

    expect(result.ok && result.content.title).toEqual({ en: 'Oat bowl' });
    expect(result.ok && Object.keys(result.content.steps)).toEqual(['en']);
  });

  it.each<[string, Partial<RecipeDraftContent>, string]>([
    ['markup stored before the rule', { titles: { en: 'Bowl <img src=x onerror=alert(1)>', pl: 'Owsianka' } }, 'invalid-draft: titles.en: markup'],
    ['a language without its text', { descriptions: { en: 'Oats.' } }, 'invalid-draft: descriptions.pl: missing-locale'],
    ['more of an ingredient than a serving holds', { ingredientsJson: [{ slug: 'rolled-oats', quantity: 10_000, unit: 'g' }] }, 'invalid-draft: ingredients[0].quantity: quantity-too-large'],
    ['a slug that would leave the data directory', { slug: '../../etc/passwd' }, 'invalid-draft: slug: invalid-slug'],
    ['servings and a meal nobody could plan', { servings: 500, mealTypes: ['brunch'] }, 'invalid-draft: servings: servings-out-of-range; mealTypes[0]: invalid-meal-type'],
  ])('does not ship with %s, and says why', (_what, over, reason) => {
    expect(shippableRecipe(draft(over))).toMatchObject({ ok: false, reason });
  });
});

describe('an ingredient-name draft that is about to ship', () => {
  it('ships the names of its own languages only', () => {
    // An English name nobody was asked to approve stays behind.
    const result = shippableIngredientName({ suggestions: { name: { pl: ' Polędwica ', en: 'Tenderloin' }, storageHint: { en: 'Chilled.' } }, locales: ['pl'] });

    expect(result).toEqual({ ok: true, content: { name: { pl: 'Polędwica' } } });
  });

  it('does not ship without a name, with markup, or when what is stored is no suggestion at all', () => {
    expect(shippableIngredientName({ suggestions: { name: {} }, locales: ['pl'] })).toMatchObject({ ok: false, reason: 'invalid-draft: name.pl: missing-locale' });
    expect(shippableIngredientName({ suggestions: { name: { pl: '<b>x</b>' } }, locales: ['pl'] })).toMatchObject({ ok: false, reason: 'invalid-draft: name.pl: markup' });
    expect(shippableIngredientName({ suggestions: 'Polędwica', locales: ['pl'] })).toMatchObject({ ok: false, reason: 'invalid-draft: name.pl: missing-locale' });
    expect(shippableIngredientName({ suggestions: null, locales: ['pl'] })).toMatchObject({ ok: false, reason: 'invalid-draft: name.pl: missing-locale' });
  });
});

describe('sorting drafts for shipping', () => {
  it('keeps their order, and reports each one held back with its reason', () => {
    const drafts = [
      { id: 'a', ...draft() },
      { id: 'b', ...draft({ servings: 0 }) },
      { id: 'c', ...draft({ slug: 'another-bowl' }) },
    ];

    const { shipping, skipped } = sortForShipping(drafts, shippableRecipe, (draft) => draft.slug);

    expect(shipping.map((entry) => [entry.draft.id, entry.content.slug])).toEqual([
      ['a', 'oat-bowl'],
      ['c', 'another-bowl'],
    ]);
    expect(skipped).toEqual([{ draftId: 'b', slug: 'oat-bowl', reason: 'invalid-draft: servings: servings-out-of-range' }]);
  });
});
