// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { minutesOf, schemaOrgRecipes } from './schema-org.adapter.js';

const oats = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: ' Overnight oats\n with blueberries ',
  description: 'Creamy no-cook oats soaked overnight.',
  recipeIngredient: ['60 g rolled oats', '180 ml whole milk', ' ', '60 g blueberries'],
  recipeInstructions: [
    { '@type': 'HowToStep', text: 'Combine the oats and the milk in a jar.' },
    { '@type': 'HowToStep', text: 'Refrigerate overnight.' },
  ],
  recipeYield: '2 servings',
  prepTime: 'PT5M',
  cookTime: 'PT0M',
  recipeCategory: 'Breakfast',
  keywords: 'oats, make ahead',
  url: 'https://recipes.example/overnight-oats',
  license: 'https://creativecommons.org/licenses/by/4.0/',
};
const read = (document: unknown) => schemaOrgRecipes.read(document);

describe('a document of schema.org recipes', () => {
  it('gives a recipe as it is written: its text made plain, its lines as they stand, where it is from', () => {
    expect(read(oats)).toEqual([
      {
        title: 'Overnight oats with blueberries',
        description: 'Creamy no-cook oats soaked overnight.',
        ingredientLines: ['60 g rolled oats', '180 ml whole milk', '60 g blueberries'],
        steps: ['Combine the oats and the milk in a jar.', 'Refrigerate overnight.'],
        servings: 2,
        prepMinutes: 5,
        cookMinutes: 0,
        categories: ['breakfast', 'oats', 'make ahead'],
        url: 'https://recipes.example/overnight-oats',
        license: 'https://creativecommons.org/licenses/by/4.0/',
      },
    ]);
  });

  it('is one recipe, a list of them, or a graph that holds some among other things', () => {
    const page = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'Recipes' }, oats, { '@type': ['Recipe', 'NewsArticle'], name: 'Porridge' }] };

    expect(read([oats, { ...oats, name: 'Porridge' }]).map((recipe) => recipe.title)).toEqual(['Overnight oats with blueberries', 'Porridge']);
    expect(read(page).map((recipe) => recipe.title)).toEqual(['Overnight oats with blueberries', 'Porridge']);
    expect(read([page, [oats]])).toHaveLength(3);
  });

  it('looks no deeper into lists within lists than a document of recipes goes', () => {
    let nested: unknown = oats;
    for (let depth = 0; depth < 5; depth += 1) nested = [nested];
    expect(read(nested)).toHaveLength(1);
    for (let depth = 0; depth < 20_000; depth += 1) nested = [nested];
    expect(read(nested)).toEqual([]);

    let steps: unknown = 'Serve.';
    for (let depth = 0; depth < 20_000; depth += 1) steps = [{ '@type': 'HowToSection', itemListElement: steps }];
    expect(read({ ...oats, recipeInstructions: steps })[0]!.steps).toEqual([]);
  });

  it('gives none for what holds no recipe', () => {
    for (const document of [null, 'a recipe', 42, {}, [], { '@type': 'Article', name: 'Oats' }, { '@graph': 'none' }]) expect(read(document)).toEqual([]);
  });

  it('reads the steps of a text of lines, of a list of texts and of sections of steps', () => {
    const steps = (recipeInstructions: unknown) => read({ ...oats, recipeInstructions })[0]!.steps;

    expect(steps('Combine.\n\nRefrigerate.\r\nServe.')).toEqual(['Combine.', 'Refrigerate.', 'Serve.']);
    expect(steps(['Combine.', '  ', 'Serve.'])).toEqual(['Combine.', 'Serve.']);
    expect(
      steps([
        { '@type': 'HowToSection', name: 'The night before', itemListElement: [{ '@type': 'HowToStep', text: 'Combine.' }, 'Refrigerate.'] },
        { '@type': 'HowToSection', itemListElement: [{ '@type': 'HowToStep', name: 'Serve.' }] },
      ]),
    ).toEqual(['Combine.', 'Refrigerate.', 'Serve.']);
    expect(steps(undefined)).toEqual([]);
  });

  it('says nothing where the source says nothing, or says it in a way that is no figure', () => {
    const bare = read({ '@type': 'Recipe', name: 'Porridge', recipeYield: 'a potful', prepTime: '10 minutes', cookTime: 'P1D', license: { name: 'CC BY-SA 4.0' }, url: 'javascript:alert(1)' })[0]!;

    expect(bare).toMatchObject({ description: '', ingredientLines: [], steps: [], servings: null, prepMinutes: null, cookMinutes: null, categories: [], url: null, license: 'CC BY-SA 4.0' });
  });

  it('takes the number that leads a yield, and the address a recipe is known by when it gives no other', () => {
    expect(read({ ...oats, recipeYield: 4 })[0]!.servings).toBe(4);
    expect(read({ ...oats, recipeYield: ['6', '6 bowls'] })[0]!.servings).toBe(6);
    expect(read({ ...oats, recipeYield: 0 })[0]!.servings).toBeNull();
    expect(read({ ...oats, url: undefined, '@id': 'https://recipes.example/#oats' })[0]!.url).toBe('https://recipes.example/#oats');
    expect(read({ ...oats, license: { '@id': 'https://creativecommons.org/publicdomain/zero/1.0/' } })[0]!.license).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(read({ ...oats, license: undefined })[0]!.license).toBeNull();
  });
});

describe('a time written as schema.org writes one', () => {
  it.each([
    ['PT5M', 5],
    ['PT1H', 60],
    ['PT1H30M', 90],
    ['PT0M', 0],
    [' PT45M ', 45],
  ])('%s is %i minutes', (duration, minutes) => {
    expect(minutesOf(duration)).toBe(minutes);
  });

  it.each(['PT', 'P1D', 'PT30S', '45', 'PT1.5H', '', null, 45])('%s is none', (duration) => {
    expect(minutesOf(duration)).toBeNull();
  });
});
