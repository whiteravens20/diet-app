// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from './classify.js';

/** Real records of the source, cut down to what the importer reads. */
const foods = JSON.parse(readFileSync(join(__dirname, 'fixtures/fdc-foods.json'), 'utf8')) as {
  description: string;
  foodCategory: string;
}[];
const of = (description: string) => {
  const food = foods.find((f) => f.description === description);
  if (!food) throw new Error(`not in the fixture: ${description}`);
  return classify(food.description, food.foodCategory);
};

const PLANT = ['vegetarian', 'vegan', 'mediterranean'];

describe('what an imported food is taken to contain', () => {
  it.each([
    ['Nuts, almonds, whole, raw', ['nuts']],
    ['Nuts, walnuts, English, halves, raw', ['nuts']],
    ['Nuts, pecans, halves, raw', ['nuts']],
    ['Nuts, hazelnuts or filberts, raw', ['nuts']],
    ['Nuts, pine nuts, raw', ['nuts']],
    ['Nuts, brazilnuts, raw', ['nuts']],
    ['Flour, chestnut', ['nuts']],
    ['Buttermilk, low fat', ['dairy']],
    ['Cheese, cheddar', ['dairy']],
    ['Butter, stick, salted', ['dairy']],
    ['Yogurt, Greek, plain, nonfat', ['dairy']],
    ['Egg, whole, raw, frozen, pasteurized', ['eggs']],
    ['Eggs, Grade A, Large, egg whole', ['eggs']],
    ['Mayonnaise, Regular', ['eggs']],
    ['Cookies, oatmeal, soft, with raisins', ['gluten']],
    ['Flour, 00', ['gluten']],
    ['Flour, pastry, unenriched, unbleached', ['gluten']],
    ['Einkorn, grain, dry, raw', ['gluten']],
    ['Khorasan, grain, dry, raw', ['gluten']],
    ['Oats, whole grain, rolled, old fashioned', ['gluten']],
    ['Pasta, dry, enriched, spaghetti', ['gluten']],
    ['Bread, white, commercial', ['gluten']],
    ['Onion rings, breaded, par fried, frozen, prepared, heated in oven', ['gluten']],
    ['Fish, salmon, Atlantic, farm raised, raw', ['fish']],
    ['Anchovies, canned in olive oil, with salt, drained', ['fish']],
    ['Fish oil, cod liver', ['fish']],
    ['Crustaceans, shrimp, farm raised, raw', ['shellfish']],
    ['Squid (calamari), frozen, tubes only', ['shellfish']],
    ['Peanuts, raw', ['peanuts']],
    ['Oil, peanut', ['peanuts']],
    ['Flour, soy, full-fat', ['soy']],
    ['Edamame, frozen, prepared', ['soy']],
    ['Hummus, commercial', ['sesame']],
  ])('finds the allergen in "%s"', (description, allergens) => {
    expect(of(description).allergens).toEqual(allergens);
  });

  it.each([
    // the stem of an allergen is in the name, the allergen is not in the food
    ['Almond butter, creamy', ['nuts']],
    ['Almond milk, unsweetened, plain, shelf stable', ['nuts']],
    ['Oat milk, unsweetened, plain, refrigerated', ['gluten']],
    ['Peanut butter, creamy', ['peanuts']],
    ['Sesame butter, creamy', ['sesame']],
    ['Soy milk, unsweetened, plain, shelf stable', ['soy']],
    ['Eggplant, raw', []],
    ['Squash, winter, butternut, raw', []],
    ['Mushroom, king oyster', []],
    ['Buckwheat, whole grain', []],
    ['Flour, buckwheat', []],
    ['Flour, rice, white, unenriched', []],
    ['Sorghum flour, white, pearled, unenriched, dry, raw', []],
    ['Sauce, pasta, spaghetti/marinara, ready-to-serve', []],
    ['Squash, spaghetti, peeled, seeded, raw', []],
  ])('is not misled by the name of "%s"', (description, allergens) => {
    expect(of(description).allergens).toEqual(allergens);
  });

  it('takes a whole category for what it consists of when the name does not say', () => {
    // A corn tortilla among baked goods: flagged, because nothing in the name rules wheat out.
    expect(of('Tortilla, corn, shelf stable').allergens).toEqual(['gluten']);
    expect(classify('Bread, gluten-free, white', 'Baked Products').allergens).toEqual([]);
  });
});

describe('which diets an imported food is known to suit', () => {
  it.each([
    'Lentils, dry',
    'Broccoli, raw',
    'Rice, white, long grain, unenriched, raw',
    'Chia seeds, dry, raw',
    'Nuts, almonds, whole, raw',
    'Apples, honeycrisp, with skin, raw',
    'Melons, honeydew, raw',
    'Beans, baked, canned, vegetarian',
    'Refried beans, canned, vegetarian',
    'Oil, olive, extra virgin',
  ])('takes "%s" for a plant, and for Mediterranean', (description) => {
    expect(of(description).diets).toEqual(PLANT);
  });

  it.each([
    'Oil, coconut',
    'Oil, peanut',
    'Sugars, granulated',
    'Almond milk, unsweetened, plain, shelf stable',
  ])('takes "%s" for a plant by its name, and claims no more', (description) => {
    expect(of(description).diets).toEqual(['vegetarian', 'vegan']);
  });

  it.each([
    'Buttermilk, low fat',
    'Cheese, cheddar',
    'Egg, whole, raw, frozen, pasteurized',
    'Honey',
  ])('takes "%s" for vegetarian and not for vegan', (description) => {
    expect(of(description).diets).toEqual(['vegetarian']);
  });

  it.each([
    'Lard',
    'Fat, beef tallow',
    'Fish oil, cod liver',
    'Soup, chicken broth, canned, condensed',
    'Chicken, breast, boneless, skinless, raw',
    'Ham, honey, smoked, cooked',
    'Baked beans, Original, canned, with pork',
    // processed, or made with things the name does not list
    'Cookies, oatmeal, soft, with raisins',
    'Bread, white, commercial',
    'Mayonnaise, Regular',
    'Sauce, pasta, spaghetti/marinara, ready-to-serve',
    'Refried beans, canned (pinto)',
    'Onion rings, breaded, par fried, frozen, prepared, heated in oven',
  ])('claims nothing for "%s"', (description) => {
    expect(of(description).diets).toEqual([]);
  });

  it('takes fish and seafood for Mediterranean and nothing else', () => {
    expect(of('Fish, salmon, Atlantic, farm raised, raw').diets).toEqual(['mediterranean']);
    expect(of('Crustaceans, shrimp, farm raised, raw').diets).toEqual(['mediterranean']);
  });
});
