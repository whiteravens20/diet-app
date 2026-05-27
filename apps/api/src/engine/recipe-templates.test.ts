import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeRecipes, type ComposableIngredient } from './recipe-templates.js';

// Compose from the real curated ingredient seed — this is what ships. The
// seed shape ships per-locale names (F14); the composer takes plain English
// names, so we flatten here at the boundary.
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../data');
interface SeedRow extends Omit<ComposableIngredient, 'name'> {
  name: string | { en: string };
}
const ingredients: ComposableIngredient[] = (
  JSON.parse(readFileSync(join(dataDir, 'ingredients.json'), 'utf8')) as SeedRow[]
).map((row) => ({
  ...row,
  name: typeof row.name === 'string' ? row.name : row.name.en,
}));

describe('composeRecipes', () => {
  const recipes = composeRecipes(ingredients);

  it('generates 100+ fallback meals from the curated database', () => {
    expect(recipes.length).toBeGreaterThanOrEqual(100);
  });

  it('is deterministic', () => {
    expect(composeRecipes(ingredients)).toEqual(recipes);
  });

  it('gives every recipe at least one diet tag and meal type', () => {
    for (const r of recipes) {
      expect(r.dietTags.length).toBeGreaterThan(0);
      expect(r.mealTypes.length).toBeGreaterThan(0);
      expect(r.ingredients.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('covers breakfast, lunch and dinner slots', () => {
    const slots = new Set(recipes.flatMap((r) => r.mealTypes));
    expect(slots.has('breakfast')).toBe(true);
    expect(slots.has('lunch')).toBe(true);
    expect(slots.has('dinner')).toBe(true);
  });

  it('never repeats an ingredient within a recipe', () => {
    for (const r of recipes) {
      const names = r.ingredients.map((i) => i.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
