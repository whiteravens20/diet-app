// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogueDirectory } from '../../testing/catalogue.js';
import { readCatalogue } from './catalogue.js';

interface RecipeRow {
  slug: string;
  title: Record<string, string>;
  servings: number;
  mealTypes: string[];
  cuisine?: string;
  source?: unknown;
  ingredients: { slug: string; quantity: number; unit: string }[];
}

/** A copy of the test catalogue whose recipes `change` may rewrite before it is read. */
function catalogueWith(change: (recipes: RecipeRow[]) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'diet-app-catalogue-check-'));
  cpSync(catalogueDirectory(), dir, { recursive: true });
  const file = join(dir, 'recipes.json');
  const recipes = JSON.parse(readFileSync(file, 'utf8')) as RecipeRow[];
  change(recipes);
  writeFileSync(file, JSON.stringify(recipes));
  return readCatalogue(dir);
}

/** A copy of the test catalogue whose ingredients `change` may rewrite before it is read. */
function ingredientsWith(change: (ingredients: Record<string, unknown>[]) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'diet-app-catalogue-check-'));
  cpSync(catalogueDirectory(), dir, { recursive: true });
  const file = join(dir, 'ingredients.json');
  const ingredients = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  change(ingredients);
  writeFileSync(file, JSON.stringify(ingredients));
  return readCatalogue(dir);
}

/** `recipe` under another name: what a second author of the same dish would hand in. */
const renamed = (recipe: RecipeRow, slug: string): RecipeRow => ({ ...recipe, slug, title: { en: `Another ${slug}`, pl: `Inne ${slug}` } });

describe('two recipes of the same making in the curated data', () => {
  it('are refused, and both are named', () => {
    const { catalogue, problems } = catalogueWith((recipes) => {
      recipes.push(renamed(recipes[0]!, 'the-same-again'));
    });

    expect(catalogue).toBeNull();
    expect(problems).toEqual([
      { file: 'recipes.json', path: `[21]`, message: 'recipe "the-same-again" is made of the same as "oat-porridge-with-banana" in recipes.json: same ingredients and amounts, meals and servings' },
    ]);
  });

  it('are the same whatever the order of their lines, and when one writes an ingredient in two lines', () => {
    const { problems } = catalogueWith((recipes) => {
      const [oats, ...rest] = recipes[0]!.ingredients;
      recipes.push({
        ...renamed(recipes[0]!, 'shuffled'),
        ingredients: [...rest.reverse(), { ...oats!, quantity: oats!.quantity - 20 }, { ...oats!, quantity: 20 }],
      });
    });

    expect(problems.map((problem) => problem.message)).toEqual([expect.stringContaining('recipe "shuffled" is made of the same as "oat-porridge-with-banana"')]);
  });

  it('are two recipes once an amount, a meal or the servings differ', () => {
    const { catalogue, problems } = catalogueWith((recipes) => {
      const first = recipes[0]!;
      recipes.push({ ...renamed(first, 'a-bigger-bowl'), ingredients: first.ingredients.map((line, i) => (i === 0 ? { ...line, quantity: line.quantity + 10 } : line)) });
      recipes.push({ ...renamed(first, 'for-lunch'), mealTypes: ['lunch'] });
      recipes.push({ ...renamed(first, 'for-two'), servings: 2 });
    });

    expect(problems).toEqual([]);
    expect(catalogue!.recipes).toHaveLength(24);
  });
});

describe('the pack of an ingredient in the curated data', () => {
  it('is read with whether an opened one keeps, and is none for what is sold loose', () => {
    const { catalogue, problems } = ingredientsWith(() => undefined);
    const packOf = (slug: string) => {
      const { packSize, perishable } = catalogue!.ingredients.find((ingredient) => ingredient.slug === slug)!;
      return { packSize, perishable };
    };

    expect(problems).toEqual([]);
    expect(packOf('chicken-breast')).toEqual({ packSize: 500, perishable: true });
    // Rice comes in a pack that keeps; a tomato comes in none.
    expect(packOf('white-rice')).toEqual({ packSize: 1000, perishable: undefined });
    expect(packOf('tomato')).toEqual({ packSize: undefined, perishable: undefined });
  });

  it('cannot be one that does not keep where there is no pack: the ingredient and the field are named', () => {
    const { catalogue, problems } = ingredientsWith((ingredients) => {
      const tomato = ingredients.findIndex((ingredient) => ingredient.slug === 'tomato');
      ingredients[tomato]!.perishable = true;
    });

    expect(catalogue).toBeNull();
    expect(problems).toEqual([{ file: 'ingredients.json', path: '[14].perishable', message: '"tomato" is marked as a pack that does not keep but has no packSize' }]);
  });

  it('has to hold something: a pack of nothing is refused', () => {
    const { catalogue, problems } = ingredientsWith((ingredients) => {
      ingredients[0]!.packSize = 0;
    });

    expect(catalogue).toBeNull();
    // The ingredient is refused first; the recipes that use it then have a line nobody knows.
    expect(problems[0]).toMatchObject({ file: 'ingredients.json', path: '[0].packSize' });
  });
});

describe('the cuisine of a recipe in the curated data', () => {
  it('is read for a recipe that names one, and is none for a recipe that names none', () => {
    const { catalogue, problems } = catalogueWith(() => undefined);
    const cuisineOf = (slug: string): string | undefined => catalogue!.recipes.find((recipe) => recipe.slug === slug)!.seed.cuisine;

    expect(problems).toEqual([]);
    expect(cuisineOf('tofu-rice-bowl')).toBe('asian');
    expect(cuisineOf('chickpea-tomato-stew')).toBe('mediterranean');
    expect(cuisineOf('milk-porridge')).toBeUndefined();
  });

  it('has to be one the application knows: another is refused, and the recipe and the field are named', () => {
    const { catalogue, problems } = catalogueWith((recipes) => {
      recipes[3]!.cuisine = 'martian';
    });

    expect(catalogue).toBeNull();
    expect(problems.map((problem) => [problem.file, problem.path])).toEqual([['recipes.json', '[3].cuisine']]);
  });
});

describe('where a recipe of the data is from', () => {
  it('is read with the recipe: an address of the web and a licence, or a licence alone', () => {
    const { catalogue, problems } = catalogueWith((recipes) => {
      recipes[0]!.source = { url: 'https://recipes.example/porridge', license: 'CC BY 4.0' };
      recipes[1]!.source = { license: 'https://creativecommons.org/publicdomain/zero/1.0/' };
    });

    expect(problems).toEqual([]);
    expect(catalogue!.recipes[0]!.seed.source).toEqual({ url: 'https://recipes.example/porridge', license: 'CC BY 4.0' });
    expect(catalogue!.recipes[1]!.seed.source).toEqual({ license: 'https://creativecommons.org/publicdomain/zero/1.0/' });
    expect(catalogue!.recipes[2]!.seed.source).toBeUndefined();
  });

  it('is refused where the address is none of the web, or the licence is not said', () => {
    const { catalogue, problems } = catalogueWith((recipes) => {
      recipes[0]!.source = { url: 'javascript:alert(1)', license: 'CC BY 4.0' };
      recipes[1]!.source = { url: 'https://recipes.example/porridge' };
    });

    expect(catalogue).toBeNull();
    expect(problems.map((problem) => `${problem.file} ${problem.path}`)).toEqual(['recipes.json [0].source.url', 'recipes.json [1].source.license']);
  });
});
