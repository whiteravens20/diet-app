// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { fileNameOf, recipeText, type SharedRecipe } from './recipe-share';

const soup: SharedRecipe = {
  title: 'Tomato soup',
  ingredientsHeading: 'Ingredients for 2\u00a0servings',
  ingredients: [
    { name: 'Tomatoes', amount: '400\u00a0g', note: 'diced' },
    { name: 'Eggs', amount: '2 eggs (110\u00a0g)', note: null },
  ],
  stepsHeading: 'Method',
  steps: ['Simmer the tomatoes.', 'Blend.'],
  notes: [],
};

describe('a recipe as a text for a message', () => {
  it('gives the title, the ingredients with their amounts and notes under what they are for, and the steps by number', () => {
    expect(recipeText(soup).split('\n')).toEqual([
      'Tomato soup',
      '',
      'Ingredients for 2 servings:',
      '- Tomatoes: 400 g — diced',
      '- Eggs: 2 eggs (110 g)',
      '',
      'Method:',
      '1. Simmer the tomatoes.',
      '2. Blend.',
    ]);
  });

  it('ends with what is said under the recipe, after a line of its own', () => {
    const text = recipeText({
      ...soup,
      notes: ['From https://recipes.example/soup\u00a0· Licence: CC BY 4.0', 'Made with a model.'],
    });

    expect(text.split('\n').slice(-3)).toEqual([
      '',
      'From https://recipes.example/soup · Licence: CC BY 4.0',
      'Made with a model.',
    ]);
  });

  it('has only plain spaces, the narrow no-break ones of a number too', () => {
    const text = recipeText({
      ...soup,
      ingredients: [{ name: 'Flour', amount: '1\u202f000\u00a0g', note: null }],
    });

    expect(text).not.toMatch(/[\u00a0\u202f]/);
    expect(text).toContain('- Flour: 1 000 g');
  });
});

describe('the name of a recipe file', () => {
  it('is the title in plain letters, digits and dashes', () => {
    expect(fileNameOf('Żurek z jajkiem i kiełbasą')).toBe('zurek-z-jajkiem-i-kielbasa');
    expect(fileNameOf('Łosoś, 2 sposoby!')).toBe('losos-2-sposoby');
    expect(fileNameOf('Crème brûlée')).toBe('creme-brulee');
  });

  it('is cut to sixty characters without a dash at its end', () => {
    const name = fileNameOf(`${'a'.repeat(59)} b c`);

    expect(name).toBe('a'.repeat(59));
  });

  it('is "recipe" where nothing of the title is left', () => {
    expect(fileNameOf('Борщ')).toBe('recipe');
    expect(fileNameOf('!!!')).toBe('recipe');
  });
});
