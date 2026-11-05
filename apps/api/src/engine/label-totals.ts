// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Fibre, sugars, salt and saturated fat as sums: of a serving, a meal, a day. Each is what its
 * known parts add up to, marked `atLeast` where a part of it is not known (a meal of one's own,
 * an ingredient its source gives no figure for), and null where no part of it is known at all.
 * The sum of no parts is nothing: zero, and known.
 */
import { LabelTotals, type LabelFigure, type LabelNutrient } from '@diet-app/shared';

/** The four, in the order they are shown. */
const LABEL_NUTRIENTS: readonly LabelNutrient[] = ['fiber', 'sugars', 'salt', 'saturatedFat'];

/** Nothing of any of them is known: a meal of one's own. */
export const UNKNOWN_LABEL: LabelTotals = {
  fiber: null,
  sugars: null,
  salt: null,
  saturatedFat: null,
};

/**
 * What 100 canonical units of an ingredient hold of them, as the catalogue keeps it. Every key is
 * there, null or not, so that a row read without them is not taken for one that lacks them.
 */
export interface LabelPer100 {
  fiberPer100: number | null | undefined;
  sugarsPer100: number | null | undefined;
  saltPer100: number | null | undefined;
  saturatedFatPer100: number | null | undefined;
}

/** For what is worked out without them: a draft, which keeps none. */
export const NO_LABEL_PER_100: LabelPer100 = {
  fiberPer100: undefined,
  sugarsPer100: undefined,
  saltPer100: undefined,
  saturatedFatPer100: undefined,
};

const PER_100: Record<LabelNutrient, keyof LabelPer100> = {
  fiber: 'fiberPer100',
  sugars: 'sugarsPer100',
  salt: 'saltPer100',
  saturatedFat: 'saturatedFatPer100',
};

const each = (make: (nutrient: LabelNutrient) => LabelFigure | null): LabelTotals => ({
  fiber: make('fiber'),
  sugars: make('sugars'),
  salt: make('salt'),
  saturatedFat: make('saturatedFat'),
});

/** What `quantity` canonical units of an ingredient hold: null for a figure the catalogue lacks. */
export function labelOfAmount(ingredient: LabelPer100, quantity: number): LabelTotals {
  return each((nutrient) => {
    const per100 = ingredient[PER_100[nutrient]];
    return per100 === null || per100 === undefined
      ? null
      : { grams: (per100 * quantity) / 100, atLeast: false };
  });
}

/** The sum of the parts: what the known ones add up to, at least that where one is not known. */
export function sumLabels(parts: readonly LabelTotals[]): LabelTotals {
  return each((nutrient) => {
    let grams = 0;
    let known = false;
    let atLeast = false;
    for (const part of parts) {
      const figure = part[nutrient];
      if (figure === null) {
        atLeast = true;
        continue;
      }
      known = true;
      grams += figure.grams;
      if (figure.atLeast) atLeast = true;
    }
    if (parts.length > 0 && !known) return null;
    return { grams, atLeast };
  });
}

/** The same, `factor` times as much: servings of a recipe, a meal scaled to its share of a day. */
export function scaleLabel(totals: LabelTotals, factor: number): LabelTotals {
  return each((nutrient) => {
    const figure = totals[nutrient];
    return figure === null ? null : { grams: figure.grams * factor, atLeast: figure.atLeast };
  });
}

/** To `places` decimal places, as they are kept and shown. */
export function roundLabel(totals: LabelTotals, places = 1): LabelTotals {
  const step = 10 ** places;
  return each((nutrient) => {
    const figure = totals[nutrient];
    return figure === null
      ? null
      : { grams: Math.round(figure.grams * step) / step, atLeast: figure.atLeast };
  });
}

/** The totals a row keeps as JSON, or null where it keeps none (or none in this shape). */
export function storedTotals(value: unknown): LabelTotals | null {
  const parsed = LabelTotals.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether two totals hold the same figures, whatever order their keys were kept in. */
export function sameTotals(a: LabelTotals | null, b: LabelTotals | null): boolean {
  if (a === null || b === null) return a === b;
  return LABEL_NUTRIENTS.every((nutrient) => {
    const x = a[nutrient];
    const y = b[nutrient];
    return x === null || y === null ? x === y : x.grams === y.grams && x.atLeast === y.atLeast;
  });
}

/** What a diary entry keeps of them: four numbers, and which of them are only a part. */
export interface StoredLabel {
  fiber: number | null;
  sugars: number | null;
  salt: number | null;
  saturatedFat: number | null;
  labelAtLeast: string[];
}

/** The totals as a diary entry keeps them. */
export function toStoredLabel(totals: LabelTotals): StoredLabel {
  return {
    fiber: totals.fiber?.grams ?? null,
    sugars: totals.sugars?.grams ?? null,
    salt: totals.salt?.grams ?? null,
    saturatedFat: totals.saturatedFat?.grams ?? null,
    labelAtLeast: LABEL_NUTRIENTS.filter((nutrient) => totals[nutrient]?.atLeast),
  };
}

/** The totals of what a diary entry keeps. */
export function fromStoredLabel(stored: StoredLabel): LabelTotals {
  return each((nutrient) => {
    const grams = stored[nutrient];
    return grams === null ? null : { grams, atLeast: stored.labelAtLeast.includes(nutrient) };
  });
}
