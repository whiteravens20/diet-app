// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DietType, fitsDiet, MealType } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import { readCatalogue } from '../admin/seed/catalogue.js';
import {
  REFERENCE_RECIPES,
  referenceCatalogueDirectory,
  referenceIngredients,
  referenceRecipes,
} from './reference-catalogue.js';

const DATA = join(__dirname, '../../../../data');

describe('the catalogue the performance budgets are measured at', () => {
  it('is the same at every run', () => {
    expect(JSON.stringify(referenceRecipes(DATA, 200))).toBe(
      JSON.stringify(referenceRecipes(DATA, 200)),
    );
  });

  it('holds as many recipes as it is asked for, each of them another dish', () => {
    const recipes = referenceRecipes(DATA, 300) as {
      slug: string;
      title: { en: string };
      ingredients: { slug: string }[];
    }[];
    expect(recipes).toHaveLength(300);
    expect(new Set(recipes.map((recipe) => recipe.slug)).size).toBe(300);
    expect(new Set(recipes.map((recipe) => recipe.title.en)).size).toBe(300);
    // No dish names an ingredient twice.
    expect(
      recipes.filter(
        (recipe) =>
          new Set(recipe.ingredients.map((line) => line.slug)).size !== recipe.ingredients.length,
      ),
    ).toEqual([]);
  });

  it('is read by the reader of the data without a complaint, and has recipes for every meal on every diet', () => {
    const { catalogue, problems } = readCatalogue(referenceCatalogueDirectory(DATA));
    expect(problems).toEqual([]);
    expect(catalogue!.recipes).toHaveLength(REFERENCE_RECIPES);
    // As many of a kind for every curated ingredient, some four hundred in all, whatever a food import left beside them on this machine.
    const curated = (JSON.parse(readFileSync(join(DATA, 'ingredients.json'), 'utf8')) as unknown[])
      .length;
    const ingredients = referenceIngredients(DATA).length;
    expect(ingredients % curated).toBe(0);
    expect(ingredients).toBeGreaterThan(300);
    expect(ingredients).toBeLessThan(500);
    expect(catalogue!.ingredients).toHaveLength(ingredients);
    for (const diet of DietType.options.filter((option) => option !== 'custom')) {
      for (const meal of MealType.options) {
        const fitting = catalogue!.recipes.filter(
          (recipe) => recipe.seed.mealTypes.includes(meal) && fitsDiet(recipe.dietTags, diet),
        );
        expect(fitting.length, `${meal} on ${diet}`).toBeGreaterThan(0);
      }
    }
  });
});
