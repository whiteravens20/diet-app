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
 *
 * F14 translation handling: each ingredient/recipe row carries an embedded
 * `{ en, pl?, ... }` for human-readable fields. The seeder writes the canonical
 * row from the numeric/structural fields, then wipes and rewrites only the
 * `source = CURATED_JSON` translation children for that parent. AI / MANUAL
 * rows survive a re-seed so the admin auto-translate output isn't blown away
 * every time the curated baseline is re-applied.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { nutritionFor, toCanonical } from '../../engine/units.js';
import { composeRecipes, type ComposableIngredient } from '../../engine/recipe-templates.js';
import { computeDataState, resolveDataDir } from './data-hash.js';

type Unit = 'g' | 'ml' | 'piece';

/** A field that may be a plain string (legacy / composer output) OR a
 *  per-locale object (new shape in data/*.json). The seeder normalises both
 *  into a Record<locale, string> for the translation tables. */
type Localised<T extends string | string[]> = T | (Record<string, T> & { en: T });

interface IngredientSeed {
  /** Stable kebab-case identifier; required for new-shape rows. */
  slug?: string;
  name: Localised<string>;
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
  storageHint?: Localised<string>;
}

interface RecipeIngredientLine {
  slug?: string;
  name?: string;
  quantity: number;
  unit: Unit;
  note?: string;
}

interface RecipeSeed {
  slug?: string;
  title: Localised<string>;
  description: Localised<string>;
  servings: number;
  mealTypes: string[];
  dietTags: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  ingredients: RecipeIngredientLine[];
  steps: Localised<string[]>;
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

export interface SeedProgress {
  stage: string;
  current?: number;
  total?: number;
}
export type ProgressCallback = (p: SeedProgress) => void;

/** Pick the English form out of either shape — used for join keys + DB
 *  canonical fields that pre-date i18n. */
function en<T extends string | string[]>(value: Localised<T>): T {
  if (typeof value === 'string') return value as T;
  if (Array.isArray(value)) return value as T;
  return (value as { en: T }).en;
}

/** Normalise a Localised<T> into `{ locale → T }`. Plain strings collapse to
 *  `{ en: value }`. */
function asLocaleMap<T extends string | string[]>(value: Localised<T>): Record<string, T> {
  if (typeof value === 'string' || Array.isArray(value)) return { en: value as T };
  return value as Record<string, T>;
}

/** Cheap deterministic slugifier — kebab-case ASCII. Mirrors the USDA
 *  importer's slugify so a composed recipe and a hand-curated row produce
 *  the same identifier for the same English title. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  onProgress: ProgressCallback = () => {},
): Promise<SeedCounts> {
  log('Seeding allergens…');
  onProgress({ stage: 'allergens' });
  for (const [code, label] of ALLERGENS) {
    await prisma.allergen.upsert({
      where: { code },
      create: { code, label },
      update: { label },
    });
  }

  log('Seeding ingredients…');
  const ingredients = loadIngredients(dir, log);
  onProgress({ stage: 'ingredients', current: 0, total: ingredients.length });

  // Two lookup tables: bySlug for the new shape, byEnName for composed-recipe
  // ingredient lines (the templates engine emits English names, not slugs).
  const bySlug = new Map<string, { id: string; row: IngredientSeed }>();
  const byEnName = new Map<string, { id: string; row: IngredientSeed }>();

  let ingredientIndex = 0;
  for (const ing of ingredients) {
    const enName = en(ing.name);
    const slug = ing.slug ?? slugify(enName);
    const nameMap = asLocaleMap(ing.name);
    const storageMap = ing.storageHint ? asLocaleMap(ing.storageHint) : null;

    // Find by slug first; fall back to the legacy English-name unique index
    // so rows that pre-date the slug column (existing seeded instances) get
    // upgraded in place instead of conflicting on a fresh insert.
    const existing =
      (await prisma.ingredient.findUnique({ where: { slug } })) ??
      (await prisma.ingredient.findUnique({ where: { name: enName } }));
    const row = existing
      ? await prisma.ingredient.update({
          where: { id: existing.id },
          data: {
            slug,
            name: enName,
            caloriesPer100: ing.caloriesPer100,
            proteinPer100: ing.proteinPer100,
            fatPer100: ing.fatPer100,
            carbsPer100: ing.carbsPer100,
            storageHint: storageMap?.en ?? null,
          },
        })
      : await prisma.ingredient.create({
          data: {
            slug,
            // Canonical English copy is duplicated on the parent so legacy
            // queries that select Ingredient without joining translations
            // still get a label. New code should always go through the
            // translations.
            name: enName,
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
            storageHint: storageMap?.en ?? null,
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
        });

    // Source-aware wipe: drop only CURATED_JSON rows for this parent so any
    // operator-added AI / MANUAL translations survive a re-seed.
    await prisma.ingredientTranslation.deleteMany({
      where: { ingredientId: row.id, source: 'CURATED_JSON' },
    });
    for (const [locale, label] of Object.entries(nameMap)) {
      await prisma.ingredientTranslation.create({
        data: {
          ingredientId: row.id,
          locale,
          name: label,
          storageHint: storageMap?.[locale] ?? null,
          source: 'CURATED_JSON',
        },
      });
    }

    bySlug.set(slug, { id: row.id, row: ing });
    byEnName.set(enName, { id: row.id, row: ing });
    ingredientIndex += 1;
    if (ingredientIndex % 100 === 0 || ingredientIndex === ingredients.length) {
      onProgress({ stage: 'ingredients', current: ingredientIndex, total: ingredients.length });
    }
  }

  const anchors = readJson<RecipeSeed[]>(dir, 'recipes.json');
  // The template composer produced semantically nonsense combinations
  // ("cucumber baked with coconut oil") and is disabled by default. Toggle
  // with RECIPE_COMPOSER_ENABLED=true as a temporary escape hatch; the
  // curation queue replaces it.
  const composerEnabled = process.env.RECIPE_COMPOSER_ENABLED === 'true';
  const composedAsSeed: RecipeSeed[] = composerEnabled
    ? composeRecipes(
        ingredients.map((i) => ({
          name: en(i.name),
          category: i.category as ComposableIngredient['category'],
          tags: i.tags,
          dietCompatibility: i.dietCompatibility as ComposableIngredient['dietCompatibility'],
        })),
      ).map((r) => ({
        ...r,
        title: r.title,
        description: r.description,
        steps: r.steps,
      }))
    : [];
  const recipes = [...anchors, ...composedAsSeed];
  log(
    `Seeding recipes (nutrition computed deterministically): ` +
      `${anchors.length} anchor + ${composedAsSeed.length} composed…`,
  );
  onProgress({ stage: 'recipes', current: 0, total: recipes.length });

  let recipeIndex = 0;
  for (const recipe of recipes) {
    let calories = 0;
    let protein = 0;
    let fat = 0;
    let carbs = 0;
    const allergens = new Set<string>();

    for (const line of recipe.ingredients) {
      const ing = line.slug ? bySlug.get(line.slug) : line.name ? byEnName.get(line.name) : undefined;
      if (!ing) {
        const ref = line.slug ?? line.name ?? '<unknown>';
        throw new Error(`recipe "${en(recipe.title)}" references unknown ingredient "${ref}"`);
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
    const enTitle = en(recipe.title);
    const enDesc = en(recipe.description);
    const enSteps = en(recipe.steps);
    const titleMap = asLocaleMap(recipe.title);
    const descMap = asLocaleMap(recipe.description);
    const stepsMap = asLocaleMap(recipe.steps);
    const slug = recipe.slug ?? slugify(enTitle);

    const ingredientLines = recipe.ingredients.map((line) => {
      const ing = line.slug ? bySlug.get(line.slug)! : byEnName.get(line.name!)!;
      return {
        ingredientId: ing.id,
        quantity: line.quantity,
        unit: line.unit,
        note: line.note ?? null,
      };
    });
    const fields = {
      title: enTitle,
      description: enDesc,
      steps: enSteps,
      servings: s,
      mealTypes: recipe.mealTypes,
      dietTags: recipe.dietTags,
      prepMinutes: recipe.prepMinutes,
      cookMinutes: recipe.cookMinutes,
      difficulty: recipe.difficulty,
      allergens: [...allergens],
      caloriesPerServing: Math.round(calories / s),
      proteinPerServing: Math.round(protein / s),
      fatPerServing: Math.round(fat / s),
      carbsPerServing: Math.round(carbs / s),
    };

    // Find the existing recipe by slug; falls back to title (English) for
    // any rows that pre-date slug introduction.
    const existing = await prisma.recipe.findFirst({
      where: { OR: [{ slug }, { title: enTitle, origin: 'seed' }] },
    });
    const upserted = existing
      ? await prisma.recipe.update({
          where: { id: existing.id },
          data: { ...fields, slug, ingredients: { deleteMany: {}, create: ingredientLines } },
        })
      : await prisma.recipe.create({
          data: {
            slug,
            origin: 'seed',
            ...fields,
            ingredients: { create: ingredientLines },
          },
        });

    await prisma.recipeTranslation.deleteMany({
      where: { recipeId: upserted.id, source: 'CURATED_JSON' },
    });
    for (const locale of Object.keys(titleMap)) {
      await prisma.recipeTranslation.create({
        data: {
          recipeId: upserted.id,
          locale,
          title: titleMap[locale],
          description: descMap[locale] ?? descMap.en,
          steps: stepsMap[locale] ?? stepsMap.en,
          source: 'CURATED_JSON',
        },
      });
    }

    recipeIndex += 1;
    if (recipeIndex % 50 === 0 || recipeIndex === recipes.length) {
      onProgress({ stage: 'recipes', current: recipeIndex, total: recipes.length });
    }
  }

  log('Seeding substitution rules…');
  onProgress({ stage: 'substitutions' });
  const subs = readJson<
    { from: string; to: string; note?: Localised<string> }[]
  >(dir, 'substitutions.json');
  let substitutions = 0;
  for (const sub of subs) {
    // Substitutions reference ingredients by slug in the new shape; fall back
    // to English name for legacy rows.
    const from = bySlug.get(sub.from) ?? byEnName.get(sub.from);
    const to = bySlug.get(sub.to) ?? byEnName.get(sub.to);
    if (!from || !to) continue;
    await prisma.substitutionRule.upsert({
      where: { fromIngredientId_toIngredientId: { fromIngredientId: from.id, toIngredientId: to.id } },
      create: {
        fromIngredientId: from.id,
        toIngredientId: to.id,
        note: sub.note ? en(sub.note) : null,
      },
      update: { note: sub.note ? en(sub.note) : null },
    });
    substitutions += 1;
  }

  return {
    ingredients: ingredients.length,
    recipes: recipes.length,
    anchorRecipes: anchors.length,
    composedRecipes: composedAsSeed.length,
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
  onProgress: ProgressCallback = () => {},
): Promise<UpdateResult> {
  log('Pruning orphan seed recipes…');
  onProgress({ stage: 'prune-recipes' });
  const deletedRecipes = await prisma.recipe.deleteMany({
    where: {
      origin: 'seed',
      plannedMeals: { none: {} },
      favorites: { none: {} },
    },
  });
  log(`  removed ${deletedRecipes.count} seed-origin recipes`);

  log('Pruning unreferenced ingredients…');
  onProgress({ stage: 'prune-ingredients' });
  const deletedIngredients = await prisma.ingredient.deleteMany({
    where: { recipeIngredients: { none: {} } },
  });
  log(`  removed ${deletedIngredients.count} unused ingredients`);

  const counts = await runSeed(prisma, dir, log, onProgress);
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
  // Dedupe by slug (preferred) or English name (legacy). Curated always wins.
  const curatedKeys = new Set<string>();
  for (const i of curated) {
    curatedKeys.add(i.slug ?? slugify(en(i.name)));
  }
  const extra = generated.filter((i) => !curatedKeys.has(i.slug ?? slugify(en(i.name))));
  log(`  + ${extra.length} USDA-imported ingredients`);
  return [...curated, ...extra];
}
