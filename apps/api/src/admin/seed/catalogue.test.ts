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
