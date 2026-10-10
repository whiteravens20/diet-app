// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { recipeFacts, type FactsIngredient, type FactsLine } from './recipe-facts.js';
import { UnitConversionError } from './units.js';

const PLANT = ['vegetarian', 'vegan', 'mediterranean'];

/** An ingredient by its numbers per 100 g: energy, protein, fat, carbohydrate. */
function ingredient(
  per100: [kcal: number, protein: number, fat: number, carbs: number],
  rest: Partial<FactsIngredient> = {},
): FactsIngredient {
  return {
    canonicalUnit: 'g',
    gramsPerPiece: null,
    density: null,
    caloriesPer100: per100[0],
    proteinPer100: per100[1],
    fatPer100: per100[2],
    carbsPer100: per100[3],
    allergens: [],
    dietCompatibility: PLANT,
    ...rest,
  };
}

const oats = ingredient([379, 13, 7, 68], { allergens: ['gluten'] });
const banana = ingredient([89, 1, 0, 23]);
const oliveOil = ingredient([884, 0, 100, 0]);
const avocado = ingredient([160, 2, 15, 9]);
const tofu = ingredient([144, 17, 9, 3], { allergens: ['soy'] });
const milk = ingredient([61, 3, 3, 5], { allergens: ['dairy'], dietCompatibility: ['vegetarian'] });
const egg = ingredient([143, 13, 10, 1], { allergens: ['eggs'], dietCompatibility: ['vegetarian', 'mediterranean'], gramsPerPiece: 55 });
const chicken = ingredient([120, 23, 3, 0], { dietCompatibility: ['mediterranean'] });
const bacon = ingredient([417, 13, 40, 1], { dietCompatibility: [] });
const rice = ingredient([360, 7, 1, 79]);

const g = (i: FactsIngredient, quantity: number): FactsLine => ({ quantity, unit: 'g', ingredient: i });

describe('the nutrition of a recipe', () => {
  it('is the sum of its lines, per serving, in whole numbers', () => {
    const facts = recipeFacts([g(oats, 60), g(banana, 120)], 1);
    // 60 g oats: 227.4 kcal; 120 g banana: 106.8 kcal.
    expect(facts.perServing).toEqual({ calories: 334, protein: 9, fat: 4, carbs: 68 });
  });

  it('is divided by the servings', () => {
    const one = recipeFacts([g(rice, 200), g(chicken, 300)], 1);
    const four = recipeFacts([g(rice, 200), g(chicken, 300)], 4);
    expect(four.perServing.calories).toBe(Math.round(one.perServing.calories / 4));
  });

  it('converts a line written in pieces', () => {
    const facts = recipeFacts([{ quantity: 2, unit: 'piece', ingredient: egg }], 1);
    expect(facts.perServing.calories).toBe(Math.round((2 * 55 * 143) / 100));
  });

  it('refuses a unit the ingredient cannot be converted from', () => {
    expect(() => recipeFacts([{ quantity: 2, unit: 'piece', ingredient: rice }], 1)).toThrow(UnitConversionError);
  });
});

describe('the allergens of a recipe', () => {
  it('are those of all its ingredients, each once, in a fixed order', () => {
    const facts = recipeFacts([g(tofu, 100), g(oats, 50), g(milk, 100), g(tofu, 20)], 1);
    expect(facts.allergens).toEqual(['dairy', 'gluten', 'soy']);
  });

  it('are none when no ingredient has any', () => {
    expect(recipeFacts([g(rice, 100), g(banana, 100)], 1).allergens).toEqual([]);
  });
});

describe('the diets a recipe qualifies for', () => {
  it.each<[string, FactsLine[], string[]]>([
    ['plants only, mostly carbohydrate', [g(oats, 60), g(banana, 120)], ['vegetarian', 'vegan', 'mediterranean']],
    ['plants with milk: no longer vegan', [g(oats, 60), g(milk, 200)], ['vegetarian']],
    ['one egg among plants', [g(rice, 80), g(egg, 55)], ['vegetarian', 'mediterranean']],
    ['meat: neither vegetarian nor vegan', [g(rice, 80), g(chicken, 150)], ['mediterranean']],
    ['an ingredient no diet lists', [g(rice, 80), g(bacon, 50)], []],
    // 100 g chicken and 10 ml oil: no carbohydrate at all.
    ['meat and fat, no carbohydrate', [g(chicken, 100), g(oliveOil, 10)], ['mediterranean', 'low_carb', 'keto']],
    // Avocado alone: 36 of 160 kcal from carbohydrate, 22 %.
    ['low in carbohydrate but not ketogenic', [g(avocado, 100)], ['vegetarian', 'vegan', 'mediterranean', 'low_carb']],
    // Tofu and oil: 12 of 232 kcal from carbohydrate, 5 %.
    ['plants that are ketogenic', [g(tofu, 100), g(oliveOil, 10)], ['vegetarian', 'vegan', 'mediterranean', 'low_carb', 'keto']],
  ])('%s', (_name, lines, expected) => {
    expect(recipeFacts(lines, 1).dietTags).toEqual(expected);
  });

  it('draws the lines for carbohydrate at 10 % and 26 % of the energy, the limit included', () => {
    // 100 kcal each, with 2.5 g, 2.6 g, 6.5 g and 6.6 g of carbohydrate.
    const at = (carbs: number) => recipeFacts([g(ingredient([100, 0, 0, carbs], { dietCompatibility: [] }), 100)], 1).dietTags;
    expect(at(2.5)).toEqual(['low_carb', 'keto']);
    expect(at(2.6)).toEqual(['low_carb']);
    expect(at(6.5)).toEqual(['low_carb']);
    expect(at(6.6)).toEqual([]);
  });

  it('does not depend on how many servings the recipe makes or how big they are', () => {
    const lines = [g(chicken, 150), g(rice, 30), g(oliveOil, 10)];
    const doubled = lines.map((line) => ({ ...line, quantity: line.quantity * 2 }));
    expect(recipeFacts(doubled, 1).dietTags).toEqual(recipeFacts(lines, 1).dietTags);
    expect(recipeFacts(lines, 4).dietTags).toEqual(recipeFacts(lines, 1).dietTags);
  });

  it('are none for a recipe without ingredients or without energy', () => {
    expect(recipeFacts([], 1).dietTags).toEqual([]);
    expect(recipeFacts([g(ingredient([0, 0, 0, 0]), 100)], 1).dietTags).toEqual([]);
  });
});
