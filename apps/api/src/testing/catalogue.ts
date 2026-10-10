// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A small catalogue for integration tests: 16 ingredients and 21 recipes that
 * fill every meal slot for a balanced and a vegan diet, with peanut, dairy,
 * gluten, egg, soy and fish allergens present. It is written to disk in the
 * shape of `data/` and loaded by the real seeder, so tests run on rows produced
 * the way production rows are.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { runSeed } from '../admin/seed/seeder.js';

type Unit = 'g' | 'ml' | 'piece';

interface FixtureIngredient {
  slug: string;
  /** The Polish name. Several begin or end with a letter outside ASCII, as real ones do. */
  pl: string;
  category: string;
  canonicalUnit: Unit;
  /** Energy, protein, fat and carbohydrate per 100 canonical units. */
  per100: [kcal: number, protein: number, fat: number, carbs: number];
  allergens: string[];
  diets: string[];
  gramsPerPiece?: number;
  density?: number;
}

// `low_carb` on an ingredient says only that it may appear in such a recipe;
// whether a recipe is low in carbohydrate depends on how much of what it uses.
const OMNIVORE = ['balanced', 'high_protein', 'low_carb'];
const VEGETARIAN = ['balanced', 'vegetarian'];
const VEGAN = ['balanced', 'vegetarian', 'vegan'];
const VEGAN_PROTEIN = [...VEGAN, 'high_protein'];

export const INGREDIENTS: FixtureIngredient[] = [
  { slug: 'rolled-oats', pl: 'Płatki owsiane', category: 'grains', canonicalUnit: 'g', per100: [379, 13, 7, 68], allergens: ['gluten'], diets: VEGAN },
  { slug: 'whole-milk', pl: 'Mleko pełne', category: 'dairy', canonicalUnit: 'ml', per100: [61, 3.2, 3.3, 4.8], allergens: ['dairy'], diets: VEGETARIAN, density: 1.03 },
  { slug: 'oat-drink', pl: 'Napój owsiany', category: 'beverages', canonicalUnit: 'ml', per100: [45, 1, 1.5, 7], allergens: [], diets: VEGAN, density: 1.03 },
  { slug: 'large-egg', pl: 'Jajko', category: 'dairy', canonicalUnit: 'g', per100: [143, 13, 9.5, 1.1], allergens: ['eggs'], diets: [...VEGETARIAN, 'high_protein'], gramsPerPiece: 55 },
  { slug: 'chicken-breast', pl: 'Pierś z kurczaka', category: 'meat', canonicalUnit: 'g', per100: [120, 22.5, 2.6, 0], allergens: [], diets: OMNIVORE },
  { slug: 'salmon', pl: 'Łosoś', category: 'fish', canonicalUnit: 'g', per100: [208, 20, 13, 0], allergens: ['fish'], diets: OMNIVORE },
  { slug: 'white-rice', pl: 'Ryż biały', category: 'grains', canonicalUnit: 'g', per100: [360, 7, 0.6, 79], allergens: [], diets: [...VEGAN, 'low_carb'] },
  { slug: 'wholegrain-bread', pl: 'Chleb pełnoziarnisty', category: 'grains', canonicalUnit: 'g', per100: [247, 13, 3.4, 41], allergens: ['gluten'], diets: VEGAN, gramsPerPiece: 35 },
  { slug: 'firm-tofu', pl: 'Tofu twarde', category: 'legumes', canonicalUnit: 'g', per100: [144, 17, 9, 3], allergens: ['soy'], diets: VEGAN_PROTEIN },
  { slug: 'chickpeas', pl: 'Ciecierzyca', category: 'legumes', canonicalUnit: 'g', per100: [164, 8.9, 2.6, 27], allergens: [], diets: VEGAN_PROTEIN },
  { slug: 'greek-yogurt', pl: 'Jogurt grecki', category: 'dairy', canonicalUnit: 'g', per100: [97, 9, 5, 4], allergens: ['dairy'], diets: [...VEGETARIAN, 'high_protein'] },
  { slug: 'peanut-butter', pl: 'Masło orzechowe', category: 'nuts_seeds', canonicalUnit: 'g', per100: [588, 25, 50, 20], allergens: ['peanuts'], diets: VEGAN_PROTEIN },
  { slug: 'banana', pl: 'Banan', category: 'fruits', canonicalUnit: 'g', per100: [89, 1.1, 0.3, 23], allergens: [], diets: VEGAN, gramsPerPiece: 120 },
  { slug: 'broccoli', pl: 'Brokuł', category: 'vegetables', canonicalUnit: 'g', per100: [34, 2.8, 0.4, 7], allergens: [], diets: VEGAN_PROTEIN },
  { slug: 'tomato', pl: 'Pomidor', category: 'vegetables', canonicalUnit: 'g', per100: [18, 0.9, 0.2, 3.9], allergens: [], diets: VEGAN_PROTEIN },
  { slug: 'olive-oil', pl: 'Oliwa z oliwek', category: 'fats_oils', canonicalUnit: 'ml', per100: [813, 0, 92, 0], allergens: [], diets: [...VEGAN_PROTEIN, 'low_carb'], density: 0.92 },
];

interface FixtureRecipe {
  slug: string;
  mealTypes: string[];
  /** Ingredient slug and quantity per serving, in the ingredient's canonical unit. */
  lines: [slug: string, quantity: number][];
}

export const RECIPES: FixtureRecipe[] = [
  { slug: 'oat-porridge-with-banana', mealTypes: ['breakfast', 'second_breakfast'], lines: [['rolled-oats', 60], ['oat-drink', 200], ['banana', 120]] },
  { slug: 'milk-porridge', mealTypes: ['breakfast'], lines: [['rolled-oats', 60], ['whole-milk', 250]] },
  { slug: 'scrambled-eggs-on-toast', mealTypes: ['breakfast'], lines: [['large-egg', 165], ['wholegrain-bread', 70], ['olive-oil', 5]] },
  { slug: 'peanut-butter-toast', mealTypes: ['breakfast', 'snack'], lines: [['wholegrain-bread', 70], ['peanut-butter', 30], ['banana', 60]] },
  { slug: 'tofu-scramble', mealTypes: ['breakfast'], lines: [['firm-tofu', 200], ['tomato', 100], ['olive-oil', 5], ['wholegrain-bread', 35]] },
  { slug: 'yogurt-with-banana', mealTypes: ['second_breakfast', 'snack'], lines: [['greek-yogurt', 200], ['banana', 120]] },
  { slug: 'banana-oat-shake', mealTypes: ['second_breakfast', 'snack'], lines: [['oat-drink', 300], ['banana', 120], ['rolled-oats', 30]] },
  { slug: 'egg-sandwich', mealTypes: ['second_breakfast'], lines: [['large-egg', 110], ['wholegrain-bread', 70], ['tomato', 50]] },
  { slug: 'chicken-rice-broccoli', mealTypes: ['lunch', 'dinner'], lines: [['chicken-breast', 150], ['white-rice', 80], ['broccoli', 150], ['olive-oil', 10]] },
  { slug: 'tofu-rice-bowl', mealTypes: ['lunch', 'dinner'], lines: [['firm-tofu', 180], ['white-rice', 80], ['broccoli', 100], ['olive-oil', 5]] },
  { slug: 'chickpea-tomato-stew', mealTypes: ['lunch', 'dinner'], lines: [['chickpeas', 250], ['tomato', 200], ['olive-oil', 10], ['white-rice', 40]] },
  { slug: 'salmon-with-rice', mealTypes: ['lunch', 'dinner'], lines: [['salmon', 140], ['white-rice', 70], ['broccoli', 100]] },
  { slug: 'egg-fried-rice', mealTypes: ['lunch'], lines: [['large-egg', 110], ['white-rice', 90], ['broccoli', 80], ['olive-oil', 10]] },
  { slug: 'chicken-sandwich', mealTypes: ['lunch'], lines: [['chicken-breast', 120], ['wholegrain-bread', 105], ['tomato', 80], ['olive-oil', 5]] },
  { slug: 'chicken-tomato-skillet', mealTypes: ['dinner'], lines: [['chicken-breast', 180], ['tomato', 250], ['olive-oil', 10], ['wholegrain-bread', 70]] },
  { slug: 'baked-tofu-with-broccoli', mealTypes: ['dinner'], lines: [['firm-tofu', 220], ['broccoli', 250], ['olive-oil', 10]] },
  { slug: 'chickpea-broccoli-salad', mealTypes: ['lunch', 'dinner'], lines: [['chickpeas', 200], ['broccoli', 150], ['tomato', 100], ['olive-oil', 15]] },
  { slug: 'peanut-tofu-stir-fry', mealTypes: ['dinner'], lines: [['firm-tofu', 150], ['peanut-butter', 25], ['white-rice', 60], ['broccoli', 100]] },
  { slug: 'banana-with-peanut-butter', mealTypes: ['snack'], lines: [['banana', 120], ['peanut-butter', 20]] },
  { slug: 'tomato-toast', mealTypes: ['snack'], lines: [['wholegrain-bread', 70], ['tomato', 100], ['olive-oil', 5]] },
  { slug: 'yogurt-oat-cup', mealTypes: ['second_breakfast', 'snack'], lines: [['greek-yogurt', 150], ['rolled-oats', 25]] },
];

/** `rolled-oats` → `Rolled oats`. */
const label = (slug: string): string => {
  const words = slug.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const bySlug = new Map(INGREDIENTS.map((i) => [i.slug, i]));

let directory: string | undefined;

/** Write the catalogue as seed files, once per process, and return their directory. */
export function catalogueDirectory(): string {
  if (directory) return directory;
  const dir = mkdtempSync(join(tmpdir(), 'diet-app-catalogue-'));

  const ingredients = INGREDIENTS.map((i) => ({
    slug: i.slug,
    name: { en: label(i.slug), pl: i.pl },
    category: i.category,
    canonicalUnit: i.canonicalUnit,
    caloriesPer100: i.per100[0],
    proteinPer100: i.per100[1],
    fatPer100: i.per100[2],
    carbsPer100: i.per100[3],
    ...(i.gramsPerPiece ? { gramsPerPiece: i.gramsPerPiece } : {}),
    ...(i.density ? { density: i.density } : {}),
    allergens: i.allergens,
    dietCompatibility: i.diets,
    tags: [],
  }));

  // Each language names the ingredients as that language's catalogue does.
  const recipes = RECIPES.map((r) => {
    const names = r.lines.map(([slug]) => label(slug).toLowerCase()).join(', ');
    const polishNames = r.lines.map(([slug]) => bySlug.get(slug)!.pl.toLowerCase()).join(', ');
    return {
      slug: r.slug,
      title: { en: label(r.slug), pl: `${label(r.slug)} (pl)` },
      description: { en: `${label(r.slug)} for one.`, pl: `${label(r.slug)} dla jednej osoby.` },
      servings: 1,
      mealTypes: r.mealTypes,
      prepMinutes: 10,
      cookMinutes: 10,
      difficulty: 'easy',
      ingredients: r.lines.map(([slug, quantity]) => ({ slug, quantity, unit: bySlug.get(slug)!.canonicalUnit })),
      steps: { en: [`Combine ${names}.`], pl: [`Połącz: ${polishNames}.`] },
    };
  });

  const substitutions = [
    { from: 'whole-milk', to: 'oat-drink' },
    { from: 'chicken-breast', to: 'firm-tofu' },
  ];

  writeFileSync(join(dir, 'ingredients.json'), JSON.stringify(ingredients));
  writeFileSync(join(dir, 'recipes.json'), JSON.stringify(recipes));
  writeFileSync(join(dir, 'substitutions.json'), JSON.stringify(substitutions));
  directory = dir;
  return dir;
}

/** Load the catalogue into an empty database through the production seeder. */
export async function seedCatalogue(prisma: PrismaClient): Promise<void> {
  await runSeed(prisma, catalogueDirectory(), () => undefined);
}
