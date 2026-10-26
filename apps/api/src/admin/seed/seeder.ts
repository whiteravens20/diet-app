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
import { allergensOf, recipeFacts } from '../../engine/recipe-facts.js';
import { UnitConversionError } from '../../engine/units.js';
import { computeFingerprint } from '../drafts/fingerprint.js';
import { asLocaleMap, en, loadCatalogue, type Catalogue } from './catalogue.js';
import { resolveDataDir } from './data-hash.js';
import { MOVABLE, moveUses, UnitsStandInTheWay } from './move-uses.js';

type Db = Prisma.TransactionClient;

/**
 * Hold the catalogue until the transaction ends. An update of the catalogue
 * and a restore of the instance's own files each take this, so that the one
 * does not read what the other has half written.
 */
export async function holdCatalogue(tx: Db): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('catalogue-update'))`;
}

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
  /** Foods of an import whose uses moved to the curated ingredient that is that food. */
  movedToSuccessors: number;
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
    await holdCatalogue(tx);

    const counts = await applyCatalogue(tx, catalogue, log, onProgress);

    onProgress({ stage: 'retire' });
    const recipes = await retireRecipes(tx, catalogue);
    log(
      `Recipes the data dropped: ${recipes.deleted} deleted, ${recipes.retired} retired (still in use).`,
    );
    const moved = await moveToSuccessors(tx, catalogue, log);
    const ingredients = await retireIngredients(tx, catalogue);
    log(
      `Ingredients the data dropped: ${ingredients.deleted} deleted, ${ingredients.retired} retired (still in use).`,
    );

    onProgress({ stage: 'recompute' });
    const recomputed = await recomputeDerivedRecipes(tx);
    if (recomputed > 0)
      log(
        `Recomputed what is derived from the ingredients of ${recomputed} recipe(s) outside the seed.`,
      );

    const repairedProfiles = await repairDanglingReferences(tx);
    if (repairedProfiles > 0)
      log(`Removed references to rows that no longer exist from ${repairedProfiles} profile(s).`);

    const seededAt = new Date();
    const meta = {
      hash: catalogue.state.hash,
      seededAt,
      ingredients: counts.ingredients,
      recipes: counts.recipes,
      substitutions: counts.substitutions,
    };
    await tx.seedMeta.upsert({
      where: { key: 'data' },
      create: { key: 'data', ...meta },
      update: meta,
    });

    return {
      ...counts,
      deletedRecipes: recipes.deleted,
      deletedIngredients: ingredients.deleted,
      retiredRecipes: recipes.retired,
      retiredIngredients: ingredients.retired,
      movedToSuccessors: moved,
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
  const existingBySlug = new Map(
    existing.filter((row) => row.slug).map((row) => [row.slug!, row.id]),
  );
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
      displayUnit: ing.displayUnit ?? null,
      perTeaspoon: ing.perTeaspoon ?? null,
      proteinKind: ing.proteinKind ?? null,
      allergens: ing.allergens,
      dietCompatibility: ing.dietCompatibility,
      tags: ing.tags,
      packSize: ing.packSize ?? null,
      perishable: ing.perishable ?? false,
      storageHint: storage?.en ?? null,
      retiredAt: null,
    };
    const id = existingBySlug.get(ing.slug) ?? unslugged.get(ing.enName);
    if (id) {
      await db.ingredient.update({ where: { id }, data: fields });
      ids.set(ing.slug, id);
    } else {
      const created = await db.ingredient.create({ data: fields });
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
        data: {
          ingredientId,
          locale,
          name,
          storageHint: storage?.[locale] ?? null,
          source: 'CURATED_JSON',
        },
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
      const storageHint =
        (entry.storageHint as Record<string, string> | undefined)?.[locale] ?? null;
      await db.ingredientTranslation.upsert({
        where: { ingredientId_locale: { ingredientId, locale } },
        create: { ingredientId, locale, name, storageHint, source: 'MANUAL' },
        update: { name, storageHint, source: 'MANUAL' },
      });
    }
    applied += 1;
  }
  log(
    `Ingredient name overrides: ${applied} applied, ${entries.length - applied} for unknown slugs skipped.`,
  );
}

async function applyRecipes(
  db: Db,
  catalogue: Catalogue,
  ingredientIds: Map<string, string>,
  log: (msg: string) => void,
  onProgress: ProgressCallback,
): Promise<void> {
  const shipped = catalogue.recipes.length - catalogue.anchorRecipes;
  log(
    `Seeding recipes (nutrition computed from the ingredient table): ${catalogue.anchorRecipes} anchor + ${shipped} shipped…`,
  );
  onProgress({ stage: 'recipes', current: 0, total: catalogue.recipes.length });

  // Only rows the seed owns are matched: a personal recipe, or one this
  // instance added, that happens to share a title is never overwritten.
  const existing = await db.recipe.findMany({
    where: { origin: 'seed' },
    select: { id: true, slug: true, title: true },
  });
  const existingBySlug = new Map(
    existing.filter((row) => row.slug).map((row) => [row.slug!, row.id]),
  );
  const unslugged = new Map(existing.filter((row) => !row.slug).map((row) => [row.title, row.id]));

  // A slug is one recipe's. Where the data now uses a slug that a recipe of
  // this instance holds, the two are told apart by what they are made of: the
  // same making is the same recipe, which becomes the data's and keeps its
  // id; another making keeps its row and gives the slug up.
  const held = await db.recipe.findMany({
    where: {
      slug: { in: catalogue.recipes.map((recipe) => recipe.slug) },
      origin: { not: 'seed' },
    },
    select: { id: true, slug: true, fingerprint: true, createdByUserId: true },
  });
  const heldBySlug = new Map(held.map((row) => [row.slug!, row]));
  let adopted = 0;
  let renamed = 0;

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
      dietTags: recipe.dietTags,
      prepMinutes: seed.prepMinutes,
      cookMinutes: seed.cookMinutes,
      difficulty: seed.difficulty,
      cuisine: seed.cuisine ?? null,
      sourceUrl: seed.source?.url ?? null,
      sourceLicense: seed.source?.license ?? null,
      allergens: recipe.allergens,
      // What a personal recipe is compared with: one that turns out to be this
      // recipe is not written a second time.
      fingerprint: computeFingerprint({
        ingredients: recipe.lines,
        mealTypes: seed.mealTypes,
        servings: seed.servings,
      }),
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
    const holder = heldBySlug.get(recipe.slug);
    if (
      holder &&
      !id &&
      holder.createdByUserId === null &&
      holder.fingerprint === fields.fingerprint
    ) {
      id = holder.id;
      adopted += 1;
    } else if (holder) {
      await db.recipe.update({ where: { id: holder.id }, data: { slug: null } });
      renamed += 1;
    }
    if (id) {
      await db.recipe.update({
        where: { id },
        data: {
          ...fields,
          origin: 'seed',
          ingredients: {
            deleteMany: {},
            create: lines.map((line, position) => ({ ...line, position })),
          },
        },
      });
    } else {
      id = (
        await db.recipe.create({
          data: {
            ...fields,
            origin: 'seed',
            ingredients: { create: lines.map((line, position) => ({ ...line, position })) },
          },
        })
      ).id;
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
  if (adopted > 0)
    log(
      `${adopted} recipe(s) this instance added are in the data now, made the same way: they are the data's from here on.`,
    );
  if (renamed > 0)
    log(
      `${renamed} recipe(s) this instance added gave up a slug the data now uses for another recipe; they stay in the library.`,
    );
}

/**
 * Seed recipes the data no longer carries. One that a plan, a favourite or a
 * favourite set still uses is retired; the rest are deleted.
 */
async function retireRecipes(
  db: Db,
  catalogue: Catalogue,
): Promise<{ deleted: number; retired: number }> {
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

  const inUse = dropped.filter(
    (row) => row._count.plannedMeals > 0 || row._count.favorites > 0 || inSets.has(row.id),
  );
  const unused = dropped.filter((row) => !inUse.includes(row));
  await db.recipe.updateMany({
    where: { id: { in: inUse.map((row) => row.id) }, retiredAt: null },
    data: { retiredAt: new Date() },
  });
  await db.recipe.deleteMany({ where: { id: { in: unused.map((row) => row.id) } } });
  return { deleted: unused.length, retired: inUse.length };
}

/** The slugs the drafts not shipped yet name in their ingredient lines. */
async function slugsOfDrafts(db: Db): Promise<Set<string>> {
  const drafts = await db.recipeDraft.findMany({
    where: { status: { not: 'SHIPPED' } },
    select: { ingredientsJson: true },
  });
  return new Set(
    drafts.flatMap((draft) =>
      (draft.ingredientsJson as unknown as { slug: string }[]).map((line) => line.slug),
    ),
  );
}

/**
 * A food of an import that a curated ingredient is (its `importedAs`): what
 * uses it moves to the curated one, so that the step after deletes it, unused.
 * One whose amounts the curated ingredient cannot be weighed in stays, retired,
 * for the administrator to replace. Returns how many foods moved.
 */
async function moveToSuccessors(
  db: Db,
  catalogue: Catalogue,
  log: (msg: string) => void,
): Promise<number> {
  if (catalogue.successors.size === 0) return 0;
  const imported = await db.ingredient.findMany({
    where: { slug: { in: [...catalogue.successors.keys()] } },
    select: MOVABLE,
  });
  let moved = 0;
  for (const food of imported) {
    const successor = await db.ingredient.findFirst({
      where: { slug: catalogue.successors.get(food.slug!)!, retiredAt: null },
      select: MOVABLE,
    });
    if (!successor?.slug) continue;
    try {
      await moveUses(db, food, { ...successor, slug: successor.slug });
      moved += 1;
    } catch (err) {
      if (!(err instanceof UnitsStandInTheWay)) throw err;
      log(`"${food.slug}" stays, retired: "${successor.slug}" ${err.message}.`);
    }
  }
  if (moved > 0) log(`Moved what used ${moved} food(s) of an import to the curated ingredient.`);
  return moved;
}

/**
 * Ingredients the data no longer carries. One that a recipe, a pantry row, a
 * preference, a shopping list or a draft still uses is retired; the rest are
 * deleted.
 */
async function retireIngredients(
  db: Db,
  catalogue: Catalogue,
): Promise<{ deleted: number; retired: number }> {
  const live = new Set(catalogue.ingredients.map((ingredient) => ingredient.slug));
  const all = await db.ingredient.findMany({
    select: {
      id: true,
      slug: true,
      _count: { select: { recipeIngredients: true, inventoryItems: true } },
    },
  });
  const dropped = all.filter((row) => !row.slug || !live.has(row.slug));
  if (dropped.length === 0) return { deleted: 0, retired: 0 };

  const referenced = new Set<string>();
  for (const pref of await db.profilePreference.findMany({
    select: { favoriteIngredientIds: true, excludedIngredientIds: true },
  })) {
    for (const id of [...pref.favoriteIngredientIds, ...pref.excludedIngredientIds])
      referenced.add(id);
  }
  for (const item of await db.shoppingListItem.findMany({
    distinct: ['ingredientId'],
    select: { ingredientId: true },
  })) {
    referenced.add(item.ingredientId);
  }
  // A draft not shipped yet names its ingredients by slug: one it names is kept, for it to be moved to another.
  const drafted = await slugsOfDrafts(db);

  const inUse = dropped.filter(
    (row) =>
      row._count.recipeIngredients > 0 ||
      row._count.inventoryItems > 0 ||
      referenced.has(row.id) ||
      (row.slug !== null && drafted.has(row.slug)),
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
 * Recipes the seed does not own (personal, AI-drafted, promoted) store their
 * nutrition, allergens, diets and fingerprint too. After the ingredient table
 * changed, bring them back in line with it. Returns how many rows changed.
 */
async function recomputeDerivedRecipes(db: Db): Promise<number> {
  const recipes = await db.recipe.findMany({
    where: { origin: { not: 'seed' } },
    include: { ingredients: { orderBy: { position: 'asc' }, include: { ingredient: true } } },
    // The order decides which of two identical recipes of one owner keeps the
    // fingerprint: one that is not deleted, then the older.
    orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }],
  });

  const fingerprints = new Map<string, string | null>();
  const taken = new Set<string>();
  for (const recipe of recipes) {
    const lines = recipe.ingredients.map((line) => ({
      slug: line.ingredient.slug,
      quantity: line.quantity,
      unit: line.unit,
    }));
    const named = lines.filter(
      (line): line is typeof line & { slug: string } => line.slug !== null,
    );
    let fingerprint =
      lines.length > 0 && named.length === lines.length
        ? computeFingerprint({
            ingredients: named,
            mealTypes: recipe.mealTypes,
            servings: recipe.servings,
          })
        : null;
    // One owner holds a fingerprint once. A second recipe of theirs with the
    // same content keeps none: it stays theirs, it is just not recognised.
    if (fingerprint && recipe.createdByUserId) {
      const key = `${recipe.createdByUserId}:${fingerprint}`;
      if (taken.has(key)) fingerprint = null;
      else taken.add(key);
    }
    fingerprints.set(recipe.id, fingerprint);
  }
  // Cleared first, so that no row waits for a value another row still holds.
  const moved = recipes.filter(
    (recipe) => recipe.fingerprint !== null && recipe.fingerprint !== fingerprints.get(recipe.id),
  );
  await db.recipe.updateMany({
    where: { id: { in: moved.map((recipe) => recipe.id) } },
    data: { fingerprint: null },
  });

  let changed = 0;
  for (const recipe of recipes) {
    const lines = recipe.ingredients.map((line) => ({
      quantity: line.quantity,
      unit: line.unit,
      ingredient: line.ingredient,
    }));
    const servings = Math.max(1, recipe.servings);
    const fingerprint = fingerprints.get(recipe.id) ?? null;
    let next: Pick<
      typeof recipe,
      | 'caloriesPerServing'
      | 'proteinPerServing'
      | 'fatPerServing'
      | 'carbsPerServing'
      | 'allergens'
      | 'dietTags'
    >;
    try {
      const facts = recipeFacts(lines, servings);
      next = {
        caloriesPerServing: facts.perServing.calories,
        proteinPerServing: facts.perServing.protein,
        fatPerServing: facts.perServing.fat,
        carbsPerServing: facts.perServing.carbs,
        allergens: facts.allergens,
        dietTags: facts.dietTags,
      };
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      // A line that can no longer be converted leaves the stored numbers alone:
      // a partial sum would be worse than the last complete one. The allergens
      // do not depend on quantities and are still brought up to date; a recipe
      // whose numbers cannot be worked out qualifies for no diet.
      next = {
        caloriesPerServing: recipe.caloriesPerServing,
        proteinPerServing: recipe.proteinPerServing,
        fatPerServing: recipe.fatPerServing,
        carbsPerServing: recipe.carbsPerServing,
        allergens: allergensOf(lines),
        dietTags: [],
      };
    }
    const same =
      next.caloriesPerServing === recipe.caloriesPerServing &&
      next.proteinPerServing === recipe.proteinPerServing &&
      next.fatPerServing === recipe.fatPerServing &&
      next.carbsPerServing === recipe.carbsPerServing &&
      next.allergens.join() === [...recipe.allergens].sort().join() &&
      next.dietTags.join() === recipe.dietTags.join() &&
      fingerprint === recipe.fingerprint;
    if (same) continue;
    await db.recipe.update({ where: { id: recipe.id }, data: { ...next, fingerprint } });
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
  const ingredientIds = new Set(
    (await db.ingredient.findMany({ select: { id: true } })).map((row) => row.id),
  );
  const recipeIds = new Set(
    (await db.recipe.findMany({ select: { id: true } })).map((row) => row.id),
  );
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
    const gone =
      pref.favoriteIngredientIds.length -
      favorite.length +
      pref.excludedIngredientIds.length -
      excluded.length;
    if (gone === 0) continue;
    await db.profilePreference.update({
      where: { id: pref.id },
      data: { favoriteIngredientIds: favorite, excludedIngredientIds: excluded },
    });
    note(pref.profileId, 'ingredients', gone);
  }

  for (const set of await db.favoriteSet.findMany({
    select: { id: true, profileId: true, slots: true },
  })) {
    const slots = set.slots as Record<string, unknown>;
    const kept = Object.fromEntries(
      Object.entries(slots).filter(
        ([, recipeId]) => typeof recipeId !== 'string' || recipeIds.has(recipeId),
      ),
    );
    const gone = Object.keys(slots).length - Object.keys(kept).length;
    if (gone === 0) continue;
    if (Object.keys(kept).length === 0) await db.favoriteSet.delete({ where: { id: set.id } });
    else
      await db.favoriteSet.update({
        where: { id: set.id },
        data: { slots: kept as Prisma.InputJsonValue },
      });
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
