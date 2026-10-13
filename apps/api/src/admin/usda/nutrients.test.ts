// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { macrosOf, type SourceNutrient } from './nutrients.js';

const foods = JSON.parse(readFileSync(join(__dirname, 'fixtures/fdc-foods.json'), 'utf8')) as {
  description: string;
  foodNutrients: SourceNutrient[];
}[];
const of = (description: string) => macrosOf(foods.find((f) => f.description === description)!.foodNutrients);
const nutrient = (nutrientNumber: string, value: number): SourceNutrient => ({ nutrientNumber, value });

describe('the energy and macronutrients of an imported food', () => {
  it('reads energy from the number the record reports it under', () => {
    // No plain energy figure in this record: the one worked out with general factors stands in.
    expect(of('Nuts, almonds, whole, raw')).toEqual({ caloriesPer100: 626, proteinPer100: 21.5, fatPer100: 51.1, carbsPer100: 20 });
    expect(of('Lard')).toEqual({ caloriesPer100: 902, proteinPer100: 0, fatPer100: 100, carbsPer100: 0 });
  });

  it('reads fat from the label figure when total lipid is not reported, and carbohydrate from the summed figure', () => {
    const base = [nutrient('203', 10), nutrient('208', 250)];
    expect(macrosOf([...base, nutrient('298', 10), nutrient('205', 30)])).toMatchObject({ fatPer100: 10, carbsPer100: 30 });
    expect(macrosOf([...base, nutrient('204', 10), nutrient('205.2', 30)])).toMatchObject({ fatPer100: 10, carbsPer100: 30 });
  });

  it('works energy out from the macronutrients when the record states none', () => {
    expect(macrosOf([nutrient('203', 10), nutrient('204', 10), nutrient('205', 30)])).toMatchObject({ caloriesPer100: 250 });
  });

  it.each([
    ['Beans, Dry, Black (0% moisture)', 'no value for carbohydrate'],
    ['Watermelon, seedless, flesh only, raw', 'no value for fat, carbohydrate'],
    ['Blackberries, raw', 'no value for fat, carbohydrate'],
    ['Bread, white, commercial', 'no value for protein, fat, carbohydrate'],
  ])('refuses "%s", which lacks a macronutrient, instead of taking it for zero', (description, reason) => {
    expect(of(description)).toEqual({ refused: reason });
  });

  it('takes a fat without protein and carbohydrate where its record names neither', () => {
    // An oil is reported with the fat of a nutrition label alone, butter with its fat and its water.
    expect(of('Oil, olive, extra virgin')).toEqual({ caloriesPer100: 843.3, proteinPer100: 0, fatPer100: 93.7, carbsPer100: 0 });
    expect(of('Oil, peanut')).toMatchObject({ proteinPer100: 0, fatPer100: 93.4, carbsPer100: 0 });
    expect(of('Butter, stick, salted')).toEqual({ caloriesPer100: 739.8, proteinPer100: 0, fatPer100: 82.2, carbsPer100: 0 });
    // What a fat does report is kept as reported.
    expect(of('Oil, coconut')).toEqual({ caloriesPer100: 833, proteinPer100: 0, fatPer100: 99.1, carbsPer100: 0.8 });
  });

  it('takes nothing for zero in a food that is not a fat, however much fat it holds', () => {
    // Under four fifths fat there is room for protein and carbohydrate: a nut holds a fifth of each.
    expect(macrosOf([nutrient('204', 79.9)])).toEqual({ refused: 'no value for protein, carbohydrate' });
    expect(macrosOf([nutrient('204', 73), nutrient('203', 10)])).toEqual({ refused: 'no value for carbohydrate' });
    expect(macrosOf([nutrient('204', 80)])).toEqual({ caloriesPer100: 720, proteinPer100: 0, fatPer100: 80, carbsPer100: 0 });
  });

  it('takes a measured zero for zero', () => {
    expect(macrosOf([nutrient('203', 0), nutrient('204', 100), nutrient('205', 0), nutrient('208', 902)])).toMatchObject({
      proteinPer100: 0,
      carbsPer100: 0,
    });
  });

  it('refuses figures that contradict each other', () => {
    // 40 % alcohol: far more energy than protein, fat and carbohydrate account for.
    expect(macrosOf([nutrient('203', 0), nutrient('204', 0), nutrient('205', 0.1), nutrient('208', 231)])).toEqual({
      refused: '231 kcal stated, 0.4 kcal from its protein, fat and carbohydrate',
    });
    expect(macrosOf([nutrient('203', 40), nutrient('204', 40), nutrient('205', 40), nutrient('208', 680)])).toEqual({
      refused: 'protein, fat and carbohydrate add up to 120 g in 100 g',
    });
  });

  it('lets fibre and rounding pass', () => {
    // Chia seeds: 34 g of the carbohydrate is fibre, which yields less than 4 kcal a gram.
    expect(of('Chia seeds, dry, raw')).toMatchObject({ caloriesPer100: 517 });
    expect(macrosOf([nutrient('203', 0.9), nutrient('204', 0.1), nutrient('205', 5.4), nutrient('208', 18)])).toMatchObject({ caloriesPer100: 18 });
  });

  it('refuses a food without energy', () => {
    expect(macrosOf([nutrient('203', 0), nutrient('204', 0), nutrient('205', 0)])).toEqual({ refused: 'no energy' });
  });
});
