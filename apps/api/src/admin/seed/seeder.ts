// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Writes the curated data into the database. The same code runs from two
 * entry points:
 *
 *   - `prisma/seed.ts` (CLI), for `npm run db:seed` on a fresh database;
 *   - `POST /api/admin/db/update`, the in-app "Update database" action.
 *
 * Three rules hold for both.
 *
 * The data is read and checked in full before the first write (`loadCatalogue`),
 * and everything is written in one transaction: an update either lands whole or
 * leaves the database as it was.
 *
 * Rows are matched by slug and updated in place, so an id never changes. User
 * data points at catalogue rows by id (pantry rows, avoided and favourite
 * ingredients, planned meals, favourites, favourite sets), and none of it may
 * be lost or left pointing at nothing because the catalogue was refreshed.
 *
 * A row the data no longer carries is deleted only when nothing refers to it.
 * Otherwise it is retired: hidden from search and from every candidate pool,
 * still there for whatever uses it.
 *
 * Nutrition and allergens are always recomputed from the ingredient table;
 * recipes never carry hand-authored values.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { nutritionFor, toCanonical, UnitConversionError } from '../../engine/units.js';
import { asLocaleMap, en, loadCatalogue, type Catalogue } from './catalogue.js';
import { resolveDataDir } from './data-hash.js';

type Db = Prisma.TransactionClient;

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

/** A whole catalogue is a few thousand statements; the default five seconds is not enough. */
const TRANSACTION = { timeout: 300_000, maxWait: 30_000 } as const;

export interface SeedCounts {
  ingredients: number;
  recipes: number;
  anchorRecipes: number;
  shippedRecipes: number;
  substitutions: number;
}

export interface UpdateResult extends SeedCounts {
  /** Rows the data dropped and nothing referred to. */
  deletedRecipes: number;
  deletedIngredients: number;
  /** Rows the data dropped while user data still refers to them: kept, hidden. */
  retiredRecipes: number;
  retiredIngredients: number;
  /** Profiles whose preferences or favourite sets pointed at rows that no longer exist. */
  repairedProfiles: number;
  hash: string;
  seededAt: Date;
}

export interface SeedProgress {
  stage: string;
  current?: number;
  total?: number;
}

export type ProgressCallback = (p: SeedProgress) => void;

/**
 * Load the curated data into the database: create what is missing, update what
 * exists, delete nothing. Used on a fresh database and by the tests.
 */
export async function runSeed(
  prisma: PrismaClient,
  dir: string = resolveDataDir(),
  log: (msg: string) => void = console.log,
  onProgress: ProgressCallback = () => {},
): Promise<SeedCounts> {
  const catalogue = loadCatalogue(dir);
  return prisma.$transaction((tx) => applyCatalogue(tx, catalogue, log, onProgress), TRANSACTION);
}

/**
 * The admin "Update database" action: bring the catalogue in line with the
 * curated data, retire what the data dropped, and recompute what depends on it.
 */
export async function updateDatabase(
  prisma: PrismaClient,
  dir: string = resolveDataDir(),
  log: (msg: string) => void = console.log,
  onProgress: ProgressCallback = () => {},
): Promise<UpdateResult> {
  // Throws before anything is written when a file is missing, malformed or
  // inconsistent with the others.
  const catalogue = loadCatalogue(dir);

  return prisma.$transaction(async (tx) => {
    // One catalogue update at a time, across every API process.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('catalogue-update'))`;

    const counts = await applyCatalogue(tx, catalogue, log, onProgress);

    onProgress({ stage: 'retire' });
    const recipes = await retireRecipes(tx, catalogue);
    log(`Recipes the data dropped: ${recipes.deleted} deleted, ${recipes.retired} retired (still in use).`);
    const ingredients = await retireIngredients(tx, catalogue);
    log(`Ingredients the data dropped: ${ingredients.deleted} deleted, ${ingredients.retired} retired (still in use).`);

    onProgress({ stage: 'recompute' });
    const recomputed = await recomputeDerivedRecipes(tx);
    if (recomputed > 0) log(`Recomputed nutrition and allergens of ${recomputed} personal recipe(s).`);

    const repairedProfiles = await repairDanglingReferences(tx);
    if (repairedProfiles > 0) log(`Removed references to rows that no longer exist from ${repairedProfiles} profile(s).`);

    const seededAt = new Date();
    const meta = {
      hash: catalogue.state.hash,
      seededAt,
      ingredients: counts.ingredients,
      recipes: counts.recipes,
      substitutions: counts.substitutions,
    };
    await tx.seedMeta.upsert({ where: { key: 'data' }, create: { key: 'data', ...meta }, update: meta });

    return {
      ...counts,
      deletedRecipes: recipes.deleted,
      deletedIngredients: ingredients.deleted,
      retiredRecipes: recipes.retired,
      retiredIngredients: ingredients.retired,
      repairedProfiles,
      hash: catalogue.state.hash,
      seededAt,
    };
  }, TRANSACTION);
}

async function applyCatalogue(
  db: Db,
  catalogue: Catalogue,
  log: (msg: string) => void,
  onProgress: ProgressCallback,
): Promise<SeedCounts> {
  log('Seeding allergens…');
  onProgress({ stage: 'allergens' });
  for (const [code, label] of ALLERGENS) {
    await db.allergen.upsert({ where: { code }, create: { code, label }, update: { label } });
  }

  const ingredientIds = await applyIngredients(db, catalogue, log, onProgress);
  await applyNameOverrides(db, catalogue, ingredientIds, log);
  await applyRecipes(db, catalogue, ingredientIds, log, onProgress);

  log('Seeding substitution rules…');
  onProgress({ stage: 'substitutions' });
  const kept: string[] = [];
  for (const sub of catalogue.substitutions) {
    const fromIngredientId = ingredientIds.get(sub.from)!;
    const toIngredientId = ingredientIds.get(sub.to)!;
    const rule = await db.substitutionRule.upsert({
      where: { fromIngredientId_toIngredientId: { fromIngredientId, toIngredientId } },
      create: { fromIngredientId, toIngredientId, note: sub.note },
      update: { note: sub.note },
    });
    kept.push(rule.id);
  }
  await db.substitutionRule.deleteMany({ where: { id: { notIn: kept } } });

  return {
    ingredients: catalogue.ingredients.length,
    recipes: catalogue.recipes.length,
    anchorRecipes: catalogue.anchorRecipes,
    shippedRecipes: catalogue.recipes.length - catalogue.anchorRecipes,
    substitutions: catalogue.substitutions.length,
  };
}

/** Create or update every ingredient of the data. Returns their ids by slug. */
async function applyIngredients(
  db: Db,
  catalogue: Catalogue,
  log: (msg: string) => void,
  onProgress: ProgressCallback,
): Promise<Map<string, string>> {
  log(`Seeding ${catalogue.ingredients.length} ingredients…`);
  onProgress({ stage: 'ingredients', current: 0, total: catalogue.ingredients.length });

  const existing = await db.ingredient.findMany({ select: { id: true, slug: true, name: true } });
  const existingBySlug = new Map(existing.filter((row) => row.slug).map((row) => [row.slug!, row.id]));
  // A row written before slugs existed is recognised by its English name, once.
  const unslugged = new Map(existing.filter((row) => !row.slug).map((row) => [row.name, row.id]));

  const ids = new Map<string, string>();
  let done = 0;
  for (const ing of catalogue.ingredients) {
    const names = asLocaleMap(ing.name);
    const storage = ing.storageHint ? asLocaleMap(ing.storageHint) : null;
    // Every structural field is written on update as well as on create, so a
    // corrected allergen, diet, unit or conversion factor reaches the database.
    const fields = {
      slug: ing.slug,
      // The English name is kept on the row for queries that do not join the
      // translations.
      name: ing.enName,
      category: ing.category,
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
      storageHint: storage?.en ?? null,
      retiredAt: null,
    };
    const per100 = {
      servingLabel: `per 100 ${ing.canonicalUnit}`,
      servingGrams: 100,
      calories: ing.caloriesPer100,
      protein: ing.proteinPer100,
      fat: ing.fatPer100,
      carbs: ing.carbsPer100,
    };

    const id = existingBySlug.get(ing.slug) ?? unslugged.get(ing.enName);
    if (id) {
      await db.ingredient.update({ where: { id }, data: fields });
      await db.nutritionFact.deleteMany({ where: { ingredientId: id } });
      await db.nutritionFact.create({ data: { ingredientId: id, ...per100 } });
      ids.set(ing.slug, id);
    } else {
      const created = await db.ingredient.create({ data: { ...fields, nutritionFacts: { create: per100 } } });
      ids.set(ing.slug, created.id);
    }

    // Names an operator approved or a model wrote outrank the curated file:
    // only the curated rows are replaced, and never over a locale that has one
    // of the others.
    const ingredientId = ids.get(ing.slug)!;
    const outranking = await db.ingredientTranslation.findMany({
      where: { ingredientId, source: { not: 'CURATED_JSON' } },
      select: { locale: true },
    });
    const taken = new Set(outranking.map((row) => row.locale));
    await db.ingredientTranslation.deleteMany({ where: { ingredientId, source: 'CURATED_JSON' } });
    for (const [locale, name] of Object.entries(names)) {
      if (taken.has(locale)) continue;
      await db.ingredientTranslation.create({
        data: { ingredientId, locale, name, storageHint: storage?.[locale] ?? null, source: 'CURATED_JSON' },
      });
    }

    done += 1;
    if (done % 100 === 0 || done === catalogue.ingredients.length) {
      onProgress({ stage: 'ingredients', current: done, total: catalogue.ingredients.length });
    }
  }
  return ids;
}

/** Friendly names approved in the curation queue, written as manual translations. */
async function applyNameOverrides(
  db: Db,
  catalogue: Catalogue,
  ingredientIds: Map<string, string>,
  log: (msg: string) => void,
): Promise<void> {
  const entries = Object.entries(catalogue.overrides);
  if (entries.length === 0) return;
  let applied = 0;
  for (const [slug, entry] of entries) {
    const ingredientId = ingredientIds.get(slug);
    if (!ingredientId) continue;
    for (const [locale, name] of Object.entries(entry.name)) {
      const storageHint = (entry.storageHint as Record<string, string> | undefined)?.[locale] ?? null;
      await db.ingredientTranslation.upsert({
        where: { ingredientId_locale: { ingredientId, locale } },
        create: { ingredientId, locale, name, storageHint, source: 'MANUAL' },
        update: { name, storageHint, source: 'MANUAL' },
      });
    }
    applied += 1;
  }
  log(`Ingredient name overrides: ${applied} applied, ${entries.length - applied} for unknown slugs skipped.`);
}

async function applyRecipes(
  db: Db,
  catalogue: Catalogue,
  ingredientIds: Map<string, string>,
  log: (msg: string) => void,
  onProgress: ProgressCallback,
): Promise<void> {
  const shipped = catalogue.recipes.length - catalogue.anchorRecipes;
  log(`Seeding recipes (nutrition computed from the ingredient table): ${catalogue.anchorRecipes} anchor + ${shipped} shipped…`);
  onProgress({ stage: 'recipes', current: 0, total: catalogue.recipes.length });

  // Only rows the seed owns are matched: a personal or promoted recipe that
  // happens to share a slug or a title is never overwritten.
  const existing = await db.recipe.findMany({
    where: { origin: 'seed' },
    select: { id: true, slug: true, title: true },
  });
  const existingBySlug = new Map(existing.filter((row) => row.slug).map((row) => [row.slug!, row.id]));
  const unslugged = new Map(existing.filter((row) => !row.slug).map((row) => [row.title, row.id]));

  let done = 0;
  for (const recipe of catalogue.recipes) {
    const { seed } = recipe;
    const titles = asLocaleMap(seed.title);
    const descriptions = asLocaleMap(seed.description);
    const steps = asLocaleMap(seed.steps);
    const fields = {
      slug: recipe.slug,
      title: en(seed.title),
      description: en(seed.description),
      steps: en(seed.steps),
      servings: seed.servings,
      mealTypes: seed.mealTypes,
      dietTags: seed.dietTags,
      prepMinutes: seed.prepMinutes,
      cookMinutes: seed.cookMinutes,
      difficulty: seed.difficulty,
      allergens: recipe.allergens,
      caloriesPerServing: recipe.nutrition.calories,
      proteinPerServing: recipe.nutrition.protein,
      fatPerServing: recipe.nutrition.fat,
      carbsPerServing: recipe.nutrition.carbs,
      retiredAt: null,
    };
    const lines = recipe.lines.map((line) => ({
      ingredientId: ingredientIds.get(line.slug)!,
      quantity: line.quantity,
      unit: line.unit,
      note: line.note ?? null,
    }));

    let id = existingBySlug.get(recipe.slug) ?? unslugged.get(fields.title);
    if (id) {
      await db.recipe.update({ where: { id }, data: { ...fields, ingredients: { deleteMany: {}, create: lines } } });
    } else {
      id = (await db.recipe.create({ data: { ...fields, origin: 'seed', ingredients: { create: lines } } })).id;
    }

    const outranking = await db.recipeTranslation.findMany({
      where: { recipeId: id, source: { not: 'CURATED_JSON' } },
      select: { locale: true },
    });
    const taken = new Set(outranking.map((row) => row.locale));
    await db.recipeTranslation.deleteMany({ where: { recipeId: id, source: 'CURATED_JSON' } });
    for (const locale of Object.keys(titles)) {
      if (taken.has(locale)) continue;
      await db.recipeTranslation.create({
        data: {
          recipeId: id,
          locale,
          title: titles[locale]!,
          description: descriptions[locale] ?? descriptions.en!,
          steps: steps[locale] ?? steps.en!,
          source: 'CURATED_JSON',
        },
      });
    }

    done += 1;
    if (done % 50 === 0 || done === catalogue.recipes.length) {
      onProgress({ stage: 'recipes', current: done, total: catalogue.recipes.length });
    }
  }
}

/**
 * Seed recipes the data no longer carries. One that a plan, a favourite or a
 * favourite set still uses is retired; the rest are deleted.
 */
async function retireRecipes(db: Db, catalogue: Catalogue): Promise<{ deleted: number; retired: number }> {
  const live = new Set(catalogue.recipes.map((recipe) => recipe.slug));
  const seeded = await db.recipe.findMany({
    where: { origin: 'seed' },
    select: { id: true, slug: true, _count: { select: { plannedMeals: true, favorites: true } } },
  });
  const dropped = seeded.filter((row) => !row.slug || !live.has(row.slug));
  if (dropped.length === 0) return { deleted: 0, retired: 0 };

  const inSets = new Set<string>();
  for (const set of await db.favoriteSet.findMany({ select: { slots: true } })) {
    for (const recipeId of recipeIdsOf(set.slots)) inSets.add(recipeId);
  }

  const inUse = dropped.filter((row) => row._count.plannedMeals > 0 || row._count.favorites > 0 || inSets.has(row.id));
  const unused = dropped.filter((row) => !inUse.includes(row));
  await db.recipe.updateMany({
    where: { id: { in: inUse.map((row) => row.id) }, retiredAt: null },
    data: { retiredAt: new Date() },
  });
  await db.recipe.deleteMany({ where: { id: { in: unused.map((row) => row.id) } } });
  return { deleted: unused.length, retired: inUse.length };
}

/**
 * Ingredients the data no longer carries. One that a recipe, a pantry row, a
 * preference or a shopping list still uses is retired; the rest are deleted.
 */
async function retireIngredients(db: Db, catalogue: Catalogue): Promise<{ deleted: number; retired: number }> {
  const live = new Set(catalogue.ingredients.map((ingredient) => ingredient.slug));
  const all = await db.ingredient.findMany({
    select: { id: true, slug: true, _count: { select: { recipeIngredients: true, inventoryItems: true } } },
  });
  const dropped = all.filter((row) => !row.slug || !live.has(row.slug));
  if (dropped.length === 0) return { deleted: 0, retired: 0 };

  const referenced = new Set<string>();
  for (const pref of await db.profilePreference.findMany({
    select: { favoriteIngredientIds: true, excludedIngredientIds: true },
  })) {
    for (const id of [...pref.favoriteIngredientIds, ...pref.excludedIngredientIds]) referenced.add(id);
  }
  for (const item of await db.shoppingListItem.findMany({ distinct: ['ingredientId'], select: { ingredientId: true } })) {
    referenced.add(item.ingredientId);
  }

  const inUse = dropped.filter(
    (row) => row._count.recipeIngredients > 0 || row._count.inventoryItems > 0 || referenced.has(row.id),
  );
  const unused = dropped.filter((row) => !inUse.includes(row));
  await db.ingredient.updateMany({
    where: { id: { in: inUse.map((row) => row.id) }, retiredAt: null },
    data: { retiredAt: new Date() },
  });
  await db.ingredient.deleteMany({ where: { id: { in: unused.map((row) => row.id) } } });
  return { deleted: unused.length, retired: inUse.length };
}

/**
 * Recipes the seed does not own (personal, AI-drafted, promoted) store derived
 * nutrition and allergens too. After the ingredient table changed, bring them
 * back in line with it. Returns how many rows changed.
 */
async function recomputeDerivedRecipes(db: Db): Promise<number> {
  const recipes = await db.recipe.findMany({
    where: { origin: { not: 'seed' } },
    include: { ingredients: { include: { ingredient: true } } },
  });
  let changed = 0;
  for (const recipe of recipes) {
    const total = { calories: 0, protein: 0, fat: 0, carbs: 0 };
    const allergens = new Set<string>();
    let convertible = true;
    for (const line of recipe.ingredients) {
      try {
        const n = nutritionFor(toCanonical(line.quantity, line.unit, line.ingredient), {
          calories: line.ingredient.caloriesPer100,
          protein: line.ingredient.proteinPer100,
          fat: line.ingredient.fatPer100,
          carbs: line.ingredient.carbsPer100,
        });
        total.calories += n.calories;
        total.protein += n.protein;
        total.fat += n.fat;
        total.carbs += n.carbs;
      } catch (err) {
        if (!(err instanceof UnitConversionError)) throw err;
        convertible = false;
      }
      line.ingredient.allergens.forEach((a) => allergens.add(a));
    }
    // A line that can no longer be converted leaves the stored numbers alone:
    // a partial sum would be worse than the last complete one.
    const servings = Math.max(1, recipe.servings);
    const next = {
      caloriesPerServing: convertible ? Math.round(total.calories / servings) : recipe.caloriesPerServing,
      proteinPerServing: convertible ? Math.round(total.protein / servings) : recipe.proteinPerServing,
      fatPerServing: convertible ? Math.round(total.fat / servings) : recipe.fatPerServing,
      carbsPerServing: convertible ? Math.round(total.carbs / servings) : recipe.carbsPerServing,
      allergens: [...allergens].sort(),
    };
    const same =
      next.caloriesPerServing === recipe.caloriesPerServing &&
      next.proteinPerServing === recipe.proteinPerServing &&
      next.fatPerServing === recipe.fatPerServing &&
      next.carbsPerServing === recipe.carbsPerServing &&
      next.allergens.join() === [...recipe.allergens].sort().join();
    if (same) continue;
    await db.recipe.update({ where: { id: recipe.id }, data: next });
    changed += 1;
  }
  return changed;
}

/**
 * Preferences and favourite sets hold catalogue ids without a foreign key. An
 * id that points at nothing filters nothing and plans nothing, silently, so it
 * is removed and the profile is told to review what it had set. Returns how
 * many profiles were touched.
 */
async function repairDanglingReferences(db: Db): Promise<number> {
  const ingredientIds = new Set((await db.ingredient.findMany({ select: { id: true } })).map((row) => row.id));
  const recipeIds = new Set((await db.recipe.findMany({ select: { id: true } })).map((row) => row.id));
  const lost = new Map<string, { ingredients: number; recipes: number }>();
  const note = (profileId: string, kind: 'ingredients' | 'recipes', count: number) => {
    const entry = lost.get(profileId) ?? { ingredients: 0, recipes: 0 };
    entry[kind] += count;
    lost.set(profileId, entry);
  };

  for (const pref of await db.profilePreference.findMany({
    select: { id: true, profileId: true, favoriteIngredientIds: true, excludedIngredientIds: true },
  })) {
    const favorite = pref.favoriteIngredientIds.filter((id) => ingredientIds.has(id));
    const excluded = pref.excludedIngredientIds.filter((id) => ingredientIds.has(id));
    const gone = pref.favoriteIngredientIds.length - favorite.length + pref.excludedIngredientIds.length - excluded.length;
    if (gone === 0) continue;
    await db.profilePreference.update({
      where: { id: pref.id },
      data: { favoriteIngredientIds: favorite, excludedIngredientIds: excluded },
    });
    note(pref.profileId, 'ingredients', gone);
  }

  for (const set of await db.favoriteSet.findMany({ select: { id: true, profileId: true, slots: true } })) {
    const slots = set.slots as Record<string, unknown>;
    const kept = Object.fromEntries(
      Object.entries(slots).filter(([, recipeId]) => typeof recipeId !== 'string' || recipeIds.has(recipeId)),
    );
    const gone = Object.keys(slots).length - Object.keys(kept).length;
    if (gone === 0) continue;
    if (Object.keys(kept).length === 0) await db.favoriteSet.delete({ where: { id: set.id } });
    else await db.favoriteSet.update({ where: { id: set.id }, data: { slots: kept as Prisma.InputJsonValue } });
    note(set.profileId, 'recipes', gone);
  }

  for (const [profileId, payload] of lost) {
    await db.notification.create({ data: { profileId, type: 'preferences_review', payload } });
  }
  return lost.size;
}

/** The recipe ids a favourite set's `{ mealType → recipeId }` map holds. */
function recipeIdsOf(slots: unknown): string[] {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return [];
  return Object.values(slots).filter((value): value is string => typeof value === 'string');
}
