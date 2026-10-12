// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { cookAhead } from './plan-menu.js';

describe('what is cooked once for two meals', () => {
  it('is cooked on the first of two days running and eaten from on the second', () => {
    expect(cookAhead([['oats', 'stew'], ['oats', 'stew'], ['eggs', 'soup']])).toEqual([
      ['cook', 'cook'],
      ['cooked', 'cooked'],
      [null, null],
    ]);
  });

  it('is cooked anew on the third day running, for that day and the one after', () => {
    expect(cookAhead([['stew'], ['stew'], ['stew'], ['stew']])).toEqual([['cook'], ['cooked'], ['cook'], ['cooked']]);
    expect(cookAhead([['stew'], ['stew'], ['stew']])).toEqual([['cook'], ['cooked'], [null]]);
  });

  it('is cooked once for two meals of one day, and for the day after with them', () => {
    expect(cookAhead([['oats', 'stew', 'stew']])).toEqual([[null, 'cook', 'cooked']]);
    expect(cookAhead([['stew', 'stew'], ['stew']])).toEqual([['cook', 'cooked'], ['cooked']]);
  });

  it('does not reach over a day between, nor over one without meals', () => {
    expect(cookAhead([['stew'], ['soup'], ['stew']])).toEqual([[null], [null], [null]]);
    expect(cookAhead([['stew'], [], ['stew']])).toEqual([[null], [], [null]]);
  });

  it('says nothing of a meal without a recipe', () => {
    expect(cookAhead([[null, 'stew'], [null, 'stew']])).toEqual([
      [null, 'cook'],
      [null, 'cooked'],
    ]);
  });
});
