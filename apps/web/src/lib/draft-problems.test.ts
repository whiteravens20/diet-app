// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { draftProblemsOf, limitOf, placeOf } from './draft-problems';

describe('the problems a refused draft edit carries', () => {
  it('are read from the details of the refusal', () => {
    const details = {
      problems: [
        { path: 'titles.pl', rule: 'markup', message: 'titles.pl holds markup' },
        { path: 'servings', rule: 'servings-out-of-range' },
      ],
    };

    expect(draftProblemsOf(details)).toEqual([
      { path: 'titles.pl', rule: 'markup' },
      { path: 'servings', rule: 'servings-out-of-range' },
    ]);
  });

  it('are none when the refusal carries something else, or nothing', () => {
    expect(draftProblemsOf(undefined)).toEqual([]);
    expect(draftProblemsOf({ problems: 'many' })).toEqual([]);
    expect(
      draftProblemsOf({
        problems: [null, 'x', { path: 1, rule: 'markup' }, { path: 'titles.pl' }],
      }),
    ).toEqual([]);
  });
});

describe('what the path of a problem names', () => {
  it.each([
    ['titles.pl', { field: 'title', locale: 'PL', n: 0 }],
    ['descriptions.en', { field: 'description', locale: 'EN', n: 0 }],
    ['steps.pl', { field: 'steps', locale: 'PL', n: 0 }],
    ['steps.en[3]', { field: 'step', locale: 'EN', n: 4 }],
    ['ingredients', { field: 'ingredients', locale: '', n: 0 }],
    ['ingredients[0]', { field: 'ingredient', locale: '', n: 1 }],
    ['ingredients[2].quantity', { field: 'ingredient', locale: '', n: 3 }],
    ['ingredients[2].note', { field: 'ingredientNote', locale: '', n: 3 }],
    ['servings', { field: 'servings', locale: '', n: 0 }],
    ['cookMinutes', { field: 'cookMinutes', locale: '', n: 0 }],
    ['mealTypes[1]', { field: 'mealTypes', locale: '', n: 0 }],
    ['name.pl', { field: 'name', locale: 'PL', n: 0 }],
    ['storageHint.pl', { field: 'storageHint', locale: 'PL', n: 0 }],
    ['something.new', { field: 'other', locale: '', n: 0 }],
  ])('%s', (path, place) => {
    expect(placeOf(path)).toEqual(place);
  });
});

describe('the number a rule names', () => {
  it('is the length of the field for a text that is too long', () => {
    expect(limitOf('text-too-long', 'title')).toBe(120);
    expect(limitOf('text-too-long', 'description')).toBe(600);
    expect(limitOf('text-too-long', 'step')).toBe(300);
    expect(limitOf('text-too-long', 'ingredientNote')).toBe(120);
    expect(limitOf('text-too-long', 'name')).toBe(120);
    expect(limitOf('text-too-long', 'storageHint')).toBe(300);
  });

  it('is the count for too many of something, and the bound of a number', () => {
    expect(limitOf('too-many-steps', 'steps')).toBe(25);
    expect(limitOf('too-many-ingredients', 'ingredients')).toBe(30);
    expect(limitOf('servings-out-of-range', 'servings')).toBe(12);
    expect(limitOf('time-out-of-range', 'cookMinutes')).toBe(480);
    expect(limitOf('markup', 'title')).toBe(0);
  });
});
