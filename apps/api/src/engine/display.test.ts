// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  displayAmount,
  displayStock,
  isCounted,
  quantityToBuy,
  quantityToClaim,
  shoppingUnit,
  type DisplayedIngredient,
} from './display.js';

const CHICKEN: DisplayedIngredient = { canonicalUnit: 'g', gramsPerPiece: null, density: null, displayUnit: null };
const MILK: DisplayedIngredient = { canonicalUnit: 'ml', gramsPerPiece: null, density: 1.03, displayUnit: null };
const EGG: DisplayedIngredient = { canonicalUnit: 'g', gramsPerPiece: 55, density: null, displayUnit: 'piece' };
const BREAD: DisplayedIngredient = { canonicalUnit: 'g', gramsPerPiece: 40, density: null, displayUnit: 'slice' };
const GARLIC: DisplayedIngredient = { canonicalUnit: 'g', gramsPerPiece: 5, density: null, displayUnit: 'clove' };
const SPINACH: DisplayedIngredient = { canonicalUnit: 'g', gramsPerPiece: 30, density: null, displayUnit: 'handful' };
const ONION: DisplayedIngredient = { canonicalUnit: 'g', gramsPerPiece: 110, density: null, displayUnit: 'piece' };
/** Has a weight per piece, but is weighed, not counted. */
const TOMATO: DisplayedIngredient = { canonicalUnit: 'g', gramsPerPiece: 120, density: null, displayUnit: null };

describe('an amount to cook with', () => {
  it.each([
    [213, 215],
    [212, 210],
    [212.4, 210],
    [1000, 1000],
    [12.4, 10],
    [12.6, 15],
  ])('rounds %s g to the nearest 5 g: %s', (exact, shownAs) => {
    expect(displayAmount(exact, 'g', CHICKEN)).toEqual({ quantity: shownAs, unit: 'g' });
  });

  it.each([
    [3, 3],
    [3.4, 3],
    [7.5, 8],
    [10, 10],
  ])('keeps a small amount of %s g to the gram: %s', (exact, shownAs) => {
    expect(displayAmount(exact, 'g', CHICKEN)).toEqual({ quantity: shownAs, unit: 'g' });
  });

  it('never shows something as nothing', () => {
    expect(displayAmount(0.2, 'g', CHICKEN)).toEqual({ quantity: 1, unit: 'g' });
    expect(displayAmount(0, 'g', CHICKEN)).toEqual({ quantity: 0, unit: 'g' });
  });

  it('rounds millilitres the same way, and shows a volume ingredient in millilitres whatever the line is in', () => {
    expect(displayAmount(248, 'ml', MILK)).toEqual({ quantity: 250, unit: 'ml' });
    expect(displayAmount(206, 'g', MILK)).toEqual({ quantity: 200, unit: 'ml' });
  });

  it('shows eggs, bread, garlic and spinach in pieces of their own, whatever the line is in', () => {
    expect(displayAmount(110, 'g', EGG)).toEqual({ quantity: 2, unit: 'piece' });
    expect(displayAmount(3, 'piece', EGG)).toEqual({ quantity: 3, unit: 'piece' });
    expect(displayAmount(80, 'g', BREAD)).toEqual({ quantity: 2, unit: 'slice' });
    expect(displayAmount(10, 'g', GARLIC)).toEqual({ quantity: 2, unit: 'clove' });
    expect(displayAmount(30, 'g', SPINACH)).toEqual({ quantity: 1, unit: 'handful' });
  });

  it('rounds pieces to halves', () => {
    expect(displayAmount(176, 'g', EGG)).toEqual({ quantity: 3, unit: 'piece' });
    expect(displayAmount(140, 'g', EGG)).toEqual({ quantity: 2.5, unit: 'piece' });
    expect(displayAmount(20, 'g', EGG)).toEqual({ quantity: 0.5, unit: 'piece' });
  });

  it('shows an amount too small to be half a piece by weight', () => {
    expect(displayAmount(5, 'g', ONION)).toEqual({ quantity: 5, unit: 'g' });
    expect(displayAmount(27, 'g', ONION)).toEqual({ quantity: 25, unit: 'g' });
    expect(displayAmount(28, 'g', ONION)).toEqual({ quantity: 0.5, unit: 'piece' });
  });

  it('shows an ingredient that is weighed in grams even where a recipe counts it', () => {
    expect(displayAmount(2, 'piece', TOMATO)).toEqual({ quantity: 240, unit: 'g' });
  });

  it('shows a line it cannot convert as it was written', () => {
    expect(displayAmount(2.2, 'piece', CHICKEN)).toEqual({ quantity: 2, unit: 'piece' });
    expect(displayAmount(0.1, 'piece', CHICKEN)).toEqual({ quantity: 0.5, unit: 'piece' });
  });
});

describe('an ingredient that is counted', () => {
  it('needs both a name for a piece and a weight for one', () => {
    expect(isCounted(EGG)).toBe(true);
    expect(isCounted(TOMATO)).toBe(false);
    expect(isCounted({ ...CHICKEN, displayUnit: 'piece' })).toBe(false);
  });
});

describe('what a pantry row holds', () => {
  it('is shown in the unit of the row, a piece called what the ingredient calls it', () => {
    expect(displayStock(6, 'piece', EGG)).toEqual({ quantity: 6, unit: 'piece' });
    expect(displayStock(4, 'piece', BREAD)).toEqual({ quantity: 4, unit: 'slice' });
    expect(displayStock(220, 'g', EGG)).toEqual({ quantity: 220, unit: 'g' });
    expect(displayStock(2, 'piece', TOMATO)).toEqual({ quantity: 2, unit: 'piece' });
  });

  it('is rounded to the gram and to half a piece, not to 5 g: it is a count of what is there', () => {
    expect(displayStock(213.4, 'g', CHICKEN)).toEqual({ quantity: 213, unit: 'g' });
    expect(displayStock(6.5454, 'piece', EGG)).toEqual({ quantity: 6.5, unit: 'piece' });
    expect(displayStock(0.1, 'piece', EGG)).toEqual({ quantity: 0.5, unit: 'piece' });
    expect(displayStock(0, 'g', CHICKEN)).toEqual({ quantity: 0, unit: 'g' });
  });
});

describe('a shopping row', () => {
  it('is counted in pieces for what is counted, and in the canonical unit otherwise', () => {
    expect(shoppingUnit(EGG)).toEqual({ unit: 'piece', displayUnit: 'piece' });
    expect(shoppingUnit(BREAD)).toEqual({ unit: 'piece', displayUnit: 'slice' });
    expect(shoppingUnit(CHICKEN)).toEqual({ unit: 'g', displayUnit: 'g' });
    expect(shoppingUnit(MILK)).toEqual({ unit: 'ml', displayUnit: 'ml' });
    expect(shoppingUnit(TOMATO)).toEqual({ unit: 'g', displayUnit: 'g' });
  });

  it.each([
    [3.2, 'piece', 4],
    [4, 'piece', 4],
    [4.0000000004, 'piece', 4],
    [0.1, 'piece', 1],
    [212.4, 'g', 215],
    [215, 'g', 215],
    [3.2, 'g', 4],
    [10.5, 'ml', 15],
    [0, 'g', 0],
  ] as const)('asks to buy at least the need: %s %s becomes %s', (need, unit, buy) => {
    expect(quantityToBuy(need, unit)).toBe(buy);
  });

  it.each([
    [2.5, 'piece', 6, 2],
    [8, 'piece', 6, 6],
    [0.9, 'piece', 6, 0],
    [237.5, 'g', 500, 235],
    [700, 'g', 500, 500],
    [4.9, 'g', 500, 4],
    [-3, 'g', 500, 0],
  ] as const)('counts on %s %s of the pantry for a need of %s as %s', (available, unit, need, claim) => {
    expect(quantityToClaim(available, unit, need)).toBe(claim);
  });
});
