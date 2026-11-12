// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { cookAhead } from './cook-ahead.js';

const marksOf = (days: (string | null)[][]) => cookAhead(days).marks;

describe('what is cooked once for two meals', () => {
  it('is cooked on the first of two days running and eaten from on the second', () => {
    expect(
      marksOf([
        ['oats', 'stew'],
        ['oats', 'stew'],
        ['eggs', 'soup'],
      ]),
    ).toEqual([
      ['cook', 'cook'],
      ['cooked', 'cooked'],
      [null, null],
    ]);
  });

  it('is cooked anew on the third day running, for that day and the one after', () => {
    expect(marksOf([['stew'], ['stew'], ['stew'], ['stew']])).toEqual([
      ['cook'],
      ['cooked'],
      ['cook'],
      ['cooked'],
    ]);
    expect(marksOf([['stew'], ['stew'], ['stew']])).toEqual([['cook'], ['cooked'], [null]]);
  });

  it('is cooked once for two meals of one day, and for the day after with them', () => {
    expect(marksOf([['oats', 'stew', 'stew']])).toEqual([[null, 'cook', 'cooked']]);
    expect(marksOf([['stew', 'stew'], ['stew']])).toEqual([['cook', 'cooked'], ['cooked']]);
  });

  it('does not reach over a day between, nor over one without meals', () => {
    expect(marksOf([['stew'], ['soup'], ['stew']])).toEqual([[null], [null], [null]]);
    expect(marksOf([['stew'], [], ['stew']])).toEqual([[null], [], [null]]);
  });

  it('says nothing of a meal without a recipe', () => {
    expect(
      marksOf([
        [null, 'stew'],
        [null, 'stew'],
      ]),
    ).toEqual([
      [null, 'cook'],
      [null, 'cooked'],
    ]);
  });

  it('names the meals each cooking feeds', () => {
    expect(
      cookAhead([
        ['oats', 'stew'],
        ['oats', 'soup'],
        ['eggs', 'soup', 'soup'],
      ]).cookings,
    ).toEqual([
      [
        { day: 0, meal: 0 },
        { day: 1, meal: 0 },
      ],
      [
        { day: 1, meal: 1 },
        { day: 2, meal: 1 },
        { day: 2, meal: 2 },
      ],
    ]);
  });

  it('has no cooking for a meal cooked for itself', () => {
    expect(cookAhead([['stew'], ['soup']]).cookings).toEqual([]);
  });
});
