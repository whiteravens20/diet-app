// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The catalogue the performance budgets are measured at: the ingredients of
 * `data/` as they are, and a number of recipes made of them here. A recipe is
 * a dish of one of a few shapes (a bowl of grain with milk and fruit, a main
 * dish of a protein with a grain and vegetables, a plate without a grain, a
 * small meal), its ingredients drawn by category and weighed so that each part
 * brings the energy such a part brings to a serving. Between them the shapes
 * give every meal recipes for every diet. The draws follow a fixed sequence:
 * the same data makes the same catalogue at every run.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cuisine, type MealType, type ProductCategory } from '@diet-app/shared';

/** How many recipes the catalogue the budgets are measured at holds. */
export const REFERENCE_RECIPES = 2000;

/** The files of `data/` the reference catalogue takes as they are. */
const TAKEN_AS_THEY_ARE = ['ingredients.json', 'ingredients.generated.json', 'ingredient-overrides.json', 'substitutions.json'];

interface DataIngredient {
  slug?: string;
  name: string | { en: string; pl?: string };
  category: ProductCategory;
  canonicalUnit: 'g' | 'ml' | 'piece';
  caloriesPer100: number;
}

/** A part of a dish: the categories it is drawn from, and the energy it brings to one serving, in kcal. */
interface Part {
  of: ProductCategory[];
  from: number;
  to: number;
}

/** A kind of dish: the meals it is eaten at, how often it is drawn, the parts it always has and the ones it sometimes has. */
interface Shape {
  meals: MealType[];
  weight: number;
  parts: Part[];
  sometimes: Part[];
}

const SHAPES: Shape[] = [
  // A bowl: a grain, milk or yoghurt, fruit, and sometimes nuts.
  {
    meals: ['breakfast', 'second_breakfast'],
    weight: 3,
    parts: [{ of: ['grains'], from: 150, to: 260 }, { of: ['dairy', 'beverages'], from: 60, to: 150 }, { of: ['fruits'], from: 40, to: 90 }],
    sometimes: [{ of: ['nuts_seeds'], from: 50, to: 110 }],
  },
  // Bread or another grain with something on it.
  {
    meals: ['breakfast'],
    weight: 3,
    parts: [{ of: ['grains'], from: 150, to: 250 }, { of: ['dairy', 'meat', 'fish', 'legumes'], from: 90, to: 200 }, { of: ['vegetables'], from: 10, to: 40 }],
    sometimes: [{ of: ['fats_oils'], from: 30, to: 70 }],
  },
  // A breakfast without a grain: cheese, meat or fish with vegetables and a fat.
  {
    meals: ['breakfast', 'second_breakfast'],
    weight: 2,
    parts: [{ of: ['dairy', 'meat', 'fish'], from: 150, to: 300 }, { of: ['vegetables'], from: 10, to: 40 }, { of: ['fats_oils'], from: 60, to: 130 }],
    sometimes: [{ of: ['nuts_seeds'], from: 40, to: 90 }],
  },
  // A main dish: a protein, a grain, vegetables, and sometimes more vegetables and a fat.
  {
    meals: ['lunch', 'dinner'],
    weight: 6,
    parts: [{ of: ['meat', 'fish', 'legumes'], from: 160, to: 320 }, { of: ['grains'], from: 150, to: 300 }, { of: ['vegetables'], from: 20, to: 70 }],
    sometimes: [{ of: ['vegetables'], from: 15, to: 50 }, { of: ['fats_oils'], from: 40, to: 110 }],
  },
  // A lunch of pulses and vegetables.
  {
    meals: ['lunch'],
    weight: 2,
    parts: [{ of: ['legumes'], from: 180, to: 320 }, { of: ['vegetables'], from: 30, to: 80 }, { of: ['vegetables'], from: 20, to: 60 }],
    sometimes: [{ of: ['grains'], from: 100, to: 200 }, { of: ['fats_oils'], from: 40, to: 90 }],
  },
  // A plate without a grain: meat or fish, vegetables and a fat.
  {
    meals: ['lunch', 'dinner'],
    weight: 3,
    parts: [{ of: ['meat', 'fish'], from: 200, to: 380 }, { of: ['vegetables'], from: 30, to: 80 }, { of: ['fats_oils'], from: 60, to: 130 }],
    sometimes: [{ of: ['vegetables'], from: 20, to: 60 }, { of: ['dairy'], from: 40, to: 100 }],
  },
  // A small meal of fruit and yoghurt.
  {
    meals: ['snack', 'second_breakfast'],
    weight: 3,
    parts: [{ of: ['fruits'], from: 50, to: 110 }, { of: ['dairy'], from: 60, to: 140 }],
    sometimes: [{ of: ['nuts_seeds'], from: 40, to: 90 }],
  },
  // A handful of nuts with fruit.
  {
    meals: ['snack'],
    weight: 2,
    parts: [{ of: ['nuts_seeds'], from: 90, to: 170 }, { of: ['fruits'], from: 40, to: 100 }],
    sometimes: [],
  },
  // Nuts with cheese or cold meat.
  {
    meals: ['snack', 'second_breakfast'],
    weight: 2,
    parts: [{ of: ['nuts_seeds'], from: 80, to: 150 }, { of: ['dairy', 'meat'], from: 60, to: 130 }],
    sometimes: [{ of: ['vegetables'], from: 10, to: 30 }],
  },
];

/** The least and the most of one ingredient in a serving, in its canonical unit. */
const LEAST_OF_AN_INGREDIENT = 5;
const MOST_OF_AN_INGREDIENT = 400;

/** Numbers from 0 up to 1, the same ones in the same order at every run. */
function fixedSequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const slugOf = (ingredient: DataIngredient): string =>
  ingredient.slug ??
  nameOf(ingredient, 'en')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function nameOf(ingredient: DataIngredient, language: 'en' | 'pl'): string {
  if (typeof ingredient.name === 'string') return ingredient.name;
  return ingredient.name[language] ?? ingredient.name.en;
}

/** `a`, `a and b`, `a, b and c`, with the word for "and" of the language. */
function listed(names: string[], and: string): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${and} ${names.at(-1)}`;
}

function read(dataDir: string, file: string): DataIngredient[] {
  const path = join(dataDir, file);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as DataIngredient[]) : [];
}

/** The recipes of the reference catalogue, as rows of a `recipes.json`. */
export function referenceRecipes(dataDir: string, count: number = REFERENCE_RECIPES): unknown[] {
  // The curated ingredients come first and an imported one of the same slug is left out, as the seeder reads them.
  const bySlug = new Map<string, DataIngredient>();
  for (const ingredient of [...read(dataDir, 'ingredients.json'), ...read(dataDir, 'ingredients.generated.json')]) {
    if (!bySlug.has(slugOf(ingredient))) bySlug.set(slugOf(ingredient), ingredient);
  }
  const byCategory = new Map<ProductCategory, DataIngredient[]>();
  for (const ingredient of bySlug.values()) {
    byCategory.set(ingredient.category, [...(byCategory.get(ingredient.category) ?? []), ingredient]);
  }

  const next = fixedSequence(20_261_013);
  const between = (from: number, to: number): number => from + next() * (to - from);
  const oneOf = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const totalWeight = SHAPES.reduce((sum, shape) => sum + shape.weight, 0);
  const shape = (): Shape => {
    let at = next() * totalWeight;
    for (const candidate of SHAPES) {
      at -= candidate.weight;
      if (at < 0) return candidate;
    }
    return SHAPES.at(-1)!;
  };

  const recipes: unknown[] = [];
  const made = new Set<string>();
  while (recipes.length < count) {
    const dish = shape();
    const parts = [...dish.parts, ...dish.sometimes.filter(() => next() < 0.5)];
    const servings = oneOf([1, 1, 1, 2, 4]);
    const lines: { ingredient: DataIngredient; quantity: number }[] = [];
    for (const part of parts) {
      const pool = part.of.flatMap((category) => byCategory.get(category) ?? []).filter((candidate) => !lines.some((line) => line.ingredient === candidate));
      if (pool.length === 0) continue;
      const ingredient = oneOf(pool);
      const energy = between(part.from, part.to);
      // What brings that energy, to five grams, and never a spoonful of nothing or a kilogram of lettuce.
      const weighed = ingredient.caloriesPer100 > 0 ? (energy / ingredient.caloriesPer100) * 100 : 100;
      const perServing = Math.min(MOST_OF_AN_INGREDIENT, Math.max(LEAST_OF_AN_INGREDIENT, Math.round(weighed / 5) * 5));
      lines.push({ ingredient, quantity: ingredient.canonicalUnit === 'piece' ? Math.max(1, Math.round(perServing / 100)) * servings : perServing * servings });
    }

    // One dish under two names would be refused by the reader of the data.
    const making = `${dish.meals.join()}|${servings}|${lines.map((line) => `${slugOf(line.ingredient)}:${line.quantity}`).sort().join()}`;
    if (made.has(making)) continue;
    made.add(making);

    const number = recipes.length + 1;
    const names = (language: 'en' | 'pl'): string[] => lines.map((line) => nameOf(line.ingredient, language));
    recipes.push({
      slug: `reference-dish-${number}`,
      title: { en: `${listed(names('en'), 'and')}, dish ${number}`, pl: `${listed(names('pl'), 'i')}, danie ${number}` },
      description: { en: `A dish of ${listed(names('en'), 'and').toLowerCase()}.`, pl: `Danie: ${listed(names('pl'), 'i').toLowerCase()}.` },
      servings,
      mealTypes: dish.meals,
      prepMinutes: 5 * Math.round(between(1, 4)),
      cookMinutes: 5 * Math.round(between(0, 8)),
      difficulty: oneOf(['easy', 'easy', 'easy', 'medium', 'medium', 'hard']),
      ...(next() < 0.4 ? { cuisine: oneOf(Cuisine.options) } : {}),
      ingredients: lines.map((line) => ({ slug: slugOf(line.ingredient), quantity: line.quantity, unit: line.ingredient.canonicalUnit })),
      steps: {
        en: [`Prepare ${listed(names('en'), 'and').toLowerCase()}.`, 'Cook what needs cooking and put the dish together.'],
        pl: [`Przygotuj: ${listed(names('pl'), 'i').toLowerCase()}.`, 'Ugotuj to, co wymaga gotowania, i połącz składniki.'],
      },
    });
  }
  return recipes;
}

let directory: string | undefined;

/** Write the reference catalogue as seed files, once per process, and return their directory. */
export function referenceCatalogueDirectory(dataDir: string): string {
  if (directory) return directory;
  const dir = mkdtempSync(join(tmpdir(), 'diet-app-reference-catalogue-'));
  for (const file of TAKEN_AS_THEY_ARE) {
    if (existsSync(join(dataDir, file))) copyFileSync(join(dataDir, file), join(dir, file));
  }
  writeFileSync(join(dir, 'recipes.json'), JSON.stringify(referenceRecipes(dataDir)));
  directory = dir;
  return dir;
}
