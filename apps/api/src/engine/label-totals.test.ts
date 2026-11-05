// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { LabelTotals } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import { labelOfAmount, roundLabel, scaleLabel, sumLabels, UNKNOWN_LABEL } from './label-totals.js';

const known = (grams: number) => ({ grams, atLeast: false });
const atLeast = (grams: number) => ({ grams, atLeast: true });

describe('fibre, sugars, salt and saturated fat as sums', () => {
  it('works out an amount of an ingredient from its figures in 100 units, and leaves out what it lacks', () => {
    expect(
      labelOfAmount(
        { fiberPer100: 2.6, sugarsPer100: 12.2, saltPer100: 0, saturatedFatPer100: null },
        150,
      ),
    ).toEqual({ fiber: known(3.9), sugars: known(18.3), salt: known(0), saturatedFat: null });
  });

  it('adds up the known parts, and marks a sum of which a part is not known as at least that much', () => {
    const banana = labelOfAmount(
      { fiberPer100: 2.6, sugarsPer100: 12.2, saltPer100: 0, saturatedFatPer100: null },
      100,
    );
    const lentils = labelOfAmount(
      { fiberPer100: 10.7, sugarsPer100: null, saltPer100: 0.02, saturatedFatPer100: undefined },
      100,
    );
    expect(roundLabel(sumLabels([banana, lentils]))).toEqual({
      fiber: known(13.3),
      sugars: atLeast(12.2),
      salt: known(0),
      saturatedFat: null,
    });
  });

  it('keeps a part that is itself at least so much as at least so much in the sum', () => {
    const recipe: LabelTotals = { ...UNKNOWN_LABEL, fiber: atLeast(4) };
    const apple: LabelTotals = { ...UNKNOWN_LABEL, fiber: known(4.3) };
    expect(sumLabels([recipe, apple]).fiber).toEqual(atLeast(8.3));
  });

  it('knows nothing of a figure no part knows, and that there is nothing in no parts at all', () => {
    expect(sumLabels([UNKNOWN_LABEL, UNKNOWN_LABEL])).toEqual(UNKNOWN_LABEL);
    expect(sumLabels([])).toEqual({
      fiber: known(0),
      sugars: known(0),
      salt: known(0),
      saturatedFat: known(0),
    });
  });

  it('scales every figure and keeps what it knows of it', () => {
    const serving: LabelTotals = {
      fiber: atLeast(2),
      sugars: known(5),
      salt: null,
      saturatedFat: known(1),
    };
    expect(scaleLabel(serving, 1.5)).toEqual({
      fiber: atLeast(3),
      sugars: known(7.5),
      salt: null,
      saturatedFat: known(1.5),
    });
  });
});
