/**
 * Curated-DB seeder. The same code runs from two entrypoints:
 *
 *   - `prisma/seed.ts` (CLI) — for `npm run db:seed` and any operator who wants
 *     to populate a fresh DB from a shell.
 *   - `POST /api/admin/db/update` — the in-app admin action. Wipes orphan
 *     seed-origin recipes + unreferenced ingredients first so the curated DB
 *     can shrink, not just grow.
 *
 * Nutrition is **always** recomputed from the ingredient table by the engine;
 * recipes never carry hand-authored kcal/macros. See ADR 0005.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { nutritionFor, toCanonical } from '../../engine/units.js';
import { composeRecipes, type ComposableIngredient } from '../../engine/recipe-templates.js';
import { computeDataState, resolveDataDir } from './data-hash.js';

type Unit = 'g' | 'ml' | 'piece';

interface IngredientSeed {
  name: string;
  category: string;
  canonicalUnit: Unit;
  caloriesPer100: number;
  proteinPer100: number;
  fatPer100: number;
  carbsPer100: number;
  gramsPerPiece?: number;
  density?: number;
  allergens: string[];
  dietCompatibility: string[];
  tags: string[];
  packSize?: number;
  storageHint?: string;
}

interface RecipeSeed {
  title: string;
  description: string;
  servings: number;
  mealTypes: string[];
  dietTags: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  ingredients: { name: string; quantity: number; unit: Unit; note?: string }[];
  steps: string[];
}

const ALLERGENS = [
  ['gluten', 'Gluten'],
  ['dairy', 'Dairy'],
  ['eggs', 'Eggs'],
  ['nuts', 'Tree nuts'],
  ['peanuts', 'Peanuts'],
  ['soy', 'Soy'],
  ['fish', 'Fish'],
  ['shellfish', 'Shellfish'],
  ['sesame', 'Sesame'],
] as const;

export interface SeedCounts {
  ingredients: number;
  recipes: number;
  anchorRecipes: number;
  composedRecipes: number;
  substitutions: number;
}

export interface UpdateResult extends SeedCounts {
  deletedRecipes: number;
  deletedIngredients: number;
  hash: string;
  seededAt: Date;
}

/**
 * Idempotent re-seed: upserts allergens / ingredients / substitutions and
 * refreshes seed recipes in place. Does NOT delete anything — pair with
 * `pruneOrphans` from `updateDatabase` when shrinking the DB is acceptable.
 */
export async function runSeed(
  prisma: PrismaClient,
  dir: string = resolveDataDir(),
  log: (msg: string) => void = console.log,
): Promise<SeedCounts> {
  log('Seeding allergens…');
  for (const [code, label] of ALLERGENS) {
    await prisma.allergen.upsert({
      where: { code },
      create: { code, label },
      update: { label },
    });
  }

  log('Seeding ingredients…');
  const ingredients = loadIngredients(dir, log);
  const byName = new Map<string, { id: string; row: IngredientSeed }>();
  for (const ing of ingredients) {
    const row = await prisma.ingredient.upsert({
      where: { name: ing.name },
      create: {
        name: ing.name,
        category: ing.category as never,
        canonicalUnit: ing.canonicalUnit,
        caloriesPer100: ing.caloriesPer100,
        proteinPer100: ing.proteinPer100,
        fatPer100: ing.fatPer100,
        carbsPer100: ing.carbsPer100,
        gramsPerPiece: ing.gramsPerPiece ?? null,
        density: ing.density ?? null,
        allergens: ing.allergens,
        dietCompatibility: ing.dietCompatibility,
        tags: ing.tags,
        packSize: ing.packSize ?? null,
        storageHint: ing.storageHint ?? null,
        nutritionFacts: {
          create: {
            servingLabel: `per 100 ${ing.canonicalUnit}`,
            servingGrams: 100,
            calories: ing.caloriesPer100,
            protein: ing.proteinPer100,
            fat: ing.fatPer100,
            carbs: ing.carbsPer100,
          },
        },
      },
      update: {
        caloriesPer100: ing.caloriesPer100,
        proteinPer100: ing.proteinPer100,
        fatPer100: ing.fatPer100,
        carbsPer100: ing.carbsPer100,
      },
    });
    byName.set(ing.name, { id: row.id, row: ing });
  }

  const anchors = readJson<RecipeSeed[]>(dir, 'recipes.json');
  const composable: ComposableIngredient[] = ingredients.map((i) => ({
    name: i.name,
    category: i.category as ComposableIngredient['category'],
    tags: i.tags,
    dietCompatibility: i.dietCompatibility as ComposableIngredient['dietCompatibility'],
  }));
  const composed = composeRecipes(composable) as RecipeSeed[];
  const recipes = [...anchors, ...composed];
  log(
    `Seeding recipes (nutrition computed deterministically): ` +
      `${anchors.length} anchor + ${composed.length} composed…`,
  );

  for (const recipe of recipes) {
    let calories = 0;
    let protein = 0;
    let fat = 0;
    let carbs = 0;
    const allergens = new Set<string>();

    for (const line of recipe.ingredients) {
      const ing = byName.get(line.name);
      if (!ing) {
        throw new Error(`recipe "${recipe.title}" references unknown ingredient "${line.name}"`);
      }
      const canonical = toCanonical(line.quantity, line.unit, {
        canonicalUnit: ing.row.canonicalUnit,
        gramsPerPiece: ing.row.gramsPerPiece ?? null,
        density: ing.row.density ?? null,
      });
      const n = nutritionFor(canonical, {
        calories: ing.row.caloriesPer100,
        protein: ing.row.proteinPer100,
        fat: ing.row.fatPer100,
        carbs: ing.row.carbsPer100,
      });
      calories += n.calories;
      protein += n.protein;
      fat += n.fat;
      carbs += n.carbs;
      ing.row.allergens.forEach((a) => allergens.add(a));
    }

    const s = recipe.servings;
    const ingredientLines = recipe.ingredients.map((line) => ({
      ingredientId: byName.get(line.name)!.id,
      quantity: line.quantity,
      unit: line.unit,
      note: line.note ?? null,
    }));
    const fields = {
      description: recipe.description,
      servings: s,
      mealTypes: recipe.mealTypes,
      dietTags: recipe.dietTags,
      steps: recipe.steps,
      prepMinutes: recipe.prepMinutes,
      cookMinutes: recipe.cookMinutes,
      difficulty: recipe.difficulty,
      allergens: [...allergens],
      caloriesPerServing: Math.round(calories / s),
      proteinPerServing: Math.round(protein / s),
      fatPerServing: Math.round(fat / s),
      carbsPerServing: Math.round(carbs / s),
    };
    // Refresh an existing seed recipe in place — its id may be referenced by
    // planned meals / favourites — otherwise create it.
    const existing = await prisma.recipe.findFirst({
      where: { title: recipe.title, origin: 'seed' },
    });
    if (existing) {
      await prisma.recipe.update({
        where: { id: existing.id },
        data: { ...fields, ingredients: { deleteMany: {}, create: ingredientLines } },
      });
    } else {
      await prisma.recipe.create({
        data: {
          title: recipe.title,
          origin: 'seed',
          ...fields,
          ingredients: { create: ingredientLines },
        },
      });
    }
  }

  log('Seeding substitution rules…');
  const subs = readJson<{ from: string; to: string; note?: string }[]>(dir, 'substitutions.json');
  let substitutions = 0;
  for (const sub of subs) {
    const from = byName.get(sub.from);
    const to = byName.get(sub.to);
    if (!from || !to) continue;
    await prisma.substitutionRule.upsert({
      where: { fromIngredientId_toIngredientId: { fromIngredientId: from.id, toIngredientId: to.id } },
      create: { fromIngredientId: from.id, toIngredientId: to.id, note: sub.note ?? null },
      update: { note: sub.note ?? null },
    });
    substitutions += 1;
  }

  return {
    ingredients: ingredients.length,
    recipes: recipes.length,
    anchorRecipes: anchors.length,
    composedRecipes: composed.length,
    substitutions,
  };
}

/**
 * Wipe-then-reseed used by the admin "Update database" button. Removes only
 * what is safe to remove — seed-origin recipes nobody planned/favorited and
 * curated ingredients no recipe still references — then runs the upsert
 * seeder. User profiles, plans, favorites, inventory, AI keys are preserved.
 *
 * Returns the new counts and the data hash so the caller can persist it to
 * `SeedMeta`.
 */
export async function updateDatabase(
  prisma: PrismaClient,
  dir: string = resolveDataDir(),
  log: (msg: string) => void = console.log,
): Promise<UpdateResult> {
  log('Pruning orphan seed recipes…');
  const deletedRecipes = await prisma.recipe.deleteMany({
    where: {
      origin: 'seed',
      plannedMeals: { none: {} },
      favorites: { none: {} },
    },
  });
  log(`  removed ${deletedRecipes.count} seed-origin recipes`);

  log('Pruning unreferenced ingredients…');
  const deletedIngredients = await prisma.ingredient.deleteMany({
    where: { recipeIngredients: { none: {} } },
  });
  log(`  removed ${deletedIngredients.count} unused ingredients`);

  const counts = await runSeed(prisma, dir, log);
  const state = computeDataState(dir);
  const seededAt = new Date();

  await prisma.seedMeta.upsert({
    where: { key: 'data' },
    create: {
      key: 'data',
      hash: state.hash,
      seededAt,
      ingredients: counts.ingredients,
      recipes: counts.recipes,
      substitutions: counts.substitutions,
    },
    update: {
      hash: state.hash,
      seededAt,
      ingredients: counts.ingredients,
      recipes: counts.recipes,
      substitutions: counts.substitutions,
    },
  });

  return {
    ...counts,
    deletedRecipes: deletedRecipes.count,
    deletedIngredients: deletedIngredients.count,
    hash: state.hash,
    seededAt,
  };
}

function readJson<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;
}

function loadIngredients(dir: string, log: (msg: string) => void): IngredientSeed[] {
  const curated = readJson<IngredientSeed[]>(dir, 'ingredients.json');
  const generatedPath = join(dir, 'ingredients.generated.json');
  if (!existsSync(generatedPath)) return curated;

  const generated = JSON.parse(readFileSync(generatedPath, 'utf8')) as IngredientSeed[];
  const curatedNames = new Set(curated.map((i) => i.name));
  const extra = generated.filter((i) => !curatedNames.has(i.name));
  log(`  + ${extra.length} USDA-imported ingredients`);
  return [...curated, ...extra];
}
