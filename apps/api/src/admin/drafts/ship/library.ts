// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A recipe that leaves the curation queue for this instance's shared library.
 * Shipping into the instance, promoting a recipe users made and restoring the
 * instance's own files all write a library recipe here, on the same terms:
 *
 *  - its ingredients are ones the catalogue has now, and its nutrition,
 *    allergens and diets are worked out from them by the engine;
 *  - where people reviewed it with figures, the figures have not moved since;
 *  - it does not take the place of a recipe it is not: its slug and its
 *    English title belong to no other recipe, and no other shared recipe is
 *    made the same way.
 *
 * A draft that is a recipe the library already has of its own, word for word
 * and line for line, is no new recipe: it brings that recipe its other
 * languages (`sameLibraryRecipe`, `addLanguages`) and nothing else is written.
 *
 * A recipe that fails one of these is not written, and the reason is named
 * as `<rule>: <detail>`: a rule a client can word in the reader's language,
 * and the slug, title or figures it is about.
 */
import type { Prisma } from '@prisma/client';
import { recipeFacts, type RecipeFacts } from '../../../engine/recipe-facts.js';
import { UnitConversionError } from '../../../engine/units.js';
import { computeFingerprint } from '../fingerprint.js';
import type { ShippedRecipe } from './recipe-batches.writer.js';
import { shippableRecipe, type RecipeDraftContent, type Skipped } from './shippable.js';

type Db = Prisma.TransactionClient;

/** The figures a draft was reviewed with. */
export interface ReviewedFacts {
  caloriesPerServing: number;
  allergens: readonly string[];
  dietTags: readonly string[];
}

/** A recipe that passed, with what the write needs. */
export interface LibraryRecipe {
  content: ShippedRecipe;
  lines: { ingredientId: string; quantity: number; unit: ShippedRecipe['ingredients'][number]['unit']; note: string | null }[];
  facts: RecipeFacts;
  fingerprint: string;
}

/**
 * What a batch has claimed so far. A bundle and a pull request write nothing
 * to the library, so two of their recipes are told apart here.
 */
export interface Claimed {
  slugs: Set<string>;
  titles: Set<string>;
  /** By what a recipe is made of, the slug of the recipe that claimed it. */
  makings: Map<string, string>;
}

export const nothingClaimed = (): Claimed => ({ slugs: new Set(), titles: new Set(), makings: new Map() });

export type Assessed = { ok: true; recipe: LibraryRecipe } | { ok: false; reason: string };

/** Largest change of a serving's energy, in kcal, that still counts as the figure people reviewed. */
const CALORIE_TOLERANCE = 1;

/** The shared recipes people can be given: nobody's own, and neither deleted nor retired. */
const SHARED = { createdByUserId: null, deletedAt: null, retiredAt: null } as const;

/** What was added to and taken from a set, as `+a -b`; empty when nothing moved. */
function moved(before: readonly string[], after: readonly string[]): string {
  const added = after.filter((value) => !before.includes(value)).map((value) => `+${value}`);
  const removed = before.filter((value) => !after.includes(value)).map((value) => `-${value}`);
  return [...added, ...removed].join(' ');
}

/**
 * Decide whether `content` may become a recipe of the shared library.
 *
 * `reviewed` are the figures people saw when they approved it. `own` is the
 * library recipe that `content` already is, when it is written over itself.
 * `claimed` holds what earlier recipes of the same batch took.
 */
export async function assessForLibrary(
  db: Db,
  content: ShippedRecipe,
  options: { reviewed?: ReviewedFacts; own?: string; claimed?: Claimed } = {},
): Promise<Assessed> {
  const slugs = [...new Set(content.ingredients.map((line) => line.slug))];
  const ingredients = await db.ingredient.findMany({
    where: { slug: { in: slugs }, retiredAt: null },
    select: {
      id: true,
      slug: true,
      canonicalUnit: true,
      gramsPerPiece: true,
      density: true,
      caloriesPer100: true,
      proteinPer100: true,
      fatPer100: true,
      carbsPer100: true,
      allergens: true,
      dietCompatibility: true,
    },
  });
  const bySlug = new Map(ingredients.map((ingredient) => [ingredient.slug!, ingredient]));
  const missing = slugs.filter((slug) => !bySlug.has(slug));
  if (missing.length > 0) return { ok: false, reason: `unknown-slug-at-ship: ${missing.join(', ')}` };

  let facts: RecipeFacts;
  try {
    facts = recipeFacts(
      content.ingredients.map((line) => ({ quantity: line.quantity, unit: line.unit, ingredient: bySlug.get(line.slug)! })),
      content.servings,
    );
  } catch (err) {
    if (!(err instanceof UnitConversionError)) throw err;
    return { ok: false, reason: `unit-not-convertible: ${err.message}` };
  }

  if (options.reviewed) {
    const { reviewed } = options;
    const changes = [
      Math.abs(facts.perServing.calories - reviewed.caloriesPerServing) > CALORIE_TOLERANCE
        ? `calories ${reviewed.caloriesPerServing} → ${facts.perServing.calories}`
        : '',
      moved(reviewed.allergens, facts.allergens) && `allergens ${moved(reviewed.allergens, facts.allergens)}`,
      moved(reviewed.dietTags, facts.dietTags) && `diets ${moved(reviewed.dietTags, facts.dietTags)}`,
    ].filter(Boolean);
    if (changes.length > 0) return { ok: false, reason: `facts-moved-since-review: ${changes.join('; ')}` };
  }

  const title = content.title.en ?? '';
  const fingerprint = computeFingerprint({ ingredients: content.ingredients, mealTypes: content.mealTypes, servings: content.servings });
  const other = options.own ? { id: { not: options.own } } : {};
  const { claimed } = options;

  // The slug is unique among all recipes, so a retired one holds its slug too.
  const holder = await db.recipe.findFirst({ where: { slug: content.slug, ...other }, select: { id: true } });
  if (holder || claimed?.slugs.has(content.slug)) return { ok: false, reason: `slug-taken: ${content.slug}` };

  const namesake = await db.recipe.findFirst({ where: { ...SHARED, ...other, title: { equals: title, mode: 'insensitive' } }, select: { id: true } });
  if (namesake || claimed?.titles.has(title.toLowerCase())) return { ok: false, reason: `title-taken: ${title}` };

  const twin = await db.recipe.findFirst({
    where: { ...SHARED, ...other, fingerprint },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { slug: true, title: true },
  });
  const made = twin ? (twin.slug ?? twin.title) : claimed?.makings.get(fingerprint);
  if (made !== undefined) return { ok: false, reason: `same-making-as: ${made}` };

  claimed?.slugs.add(content.slug);
  claimed?.titles.add(title.toLowerCase());
  claimed?.makings.set(fingerprint, content.slug);

  return {
    ok: true,
    recipe: {
      content,
      lines: content.ingredients.map((line) => ({
        ingredientId: bySlug.get(line.slug)!.id,
        quantity: line.quantity,
        unit: line.unit,
        note: line.note ?? null,
      })),
      facts,
      fingerprint,
    },
  };
}

/**
 * Write a recipe that passed `assessForLibrary`, and return its id. With
 * `own` the library recipe of that id is written over and keeps its id;
 * without it a new recipe is made.
 *
 * The recipe is `curated`: shared, and approved by people on this instance.
 * Its text is stored as theirs, in the languages the content carries; text of
 * another language the recipe already has is left alone.
 */
export async function writeToLibrary(tx: Db, recipe: LibraryRecipe, own?: string): Promise<string> {
  const { content, facts } = recipe;
  const english = { title: content.title.en!, description: content.description.en ?? '', steps: content.steps.en ?? [] };
  const fields = {
    slug: content.slug,
    ...english,
    servings: content.servings,
    mealTypes: content.mealTypes,
    dietTags: facts.dietTags,
    prepMinutes: content.prepMinutes,
    cookMinutes: content.cookMinutes,
    difficulty: content.difficulty,
    cuisine: content.cuisine ?? null,
    allergens: facts.allergens,
    origin: 'curated' as const,
    sourceUrl: content.source?.url ?? null,
    sourceLicense: content.source?.license ?? null,
    createdByUserId: null,
    // What a personal recipe is compared with: one that turns out to be this
    // recipe is not written a second time.
    fingerprint: recipe.fingerprint,
    caloriesPerServing: facts.perServing.calories,
    proteinPerServing: facts.perServing.protein,
    fatPerServing: facts.perServing.fat,
    carbsPerServing: facts.perServing.carbs,
  };
  const id = own
    ? (await tx.recipe.update({ where: { id: own }, data: { ...fields, ingredients: { deleteMany: {}, create: recipe.lines } }, select: { id: true } })).id
    : (await tx.recipe.create({ data: { ...fields, ingredients: { create: recipe.lines } }, select: { id: true } })).id;

  for (const locale of Object.keys(content.title)) {
    const text = {
      title: content.title[locale as keyof typeof content.title] ?? english.title,
      description: content.description[locale as keyof typeof content.description] ?? english.description,
      steps: content.steps[locale as keyof typeof content.steps] ?? english.steps,
      // Approved by people. Not `CURATED_JSON`: that is text from the data
      // files, which an update rewrites.
      source: 'MANUAL' as const,
    };
    await tx.recipeTranslation.upsert({
      where: { recipeId_locale: { recipeId: id, locale } },
      create: { recipeId: id, locale, ...text },
      update: text,
    });
  }
  return id;
}

/** The library's own recipes: shipped into this instance, and neither deleted nor retired. */
const OWN = { ...SHARED, origin: 'curated' } as const;

/**
 * Whether `content` is a recipe the library already has of its own: the same
 * slug, made the same way, with the same English text. Such a draft brings
 * the recipe more languages and changes nothing else of it. `changed` when
 * the slug is such a recipe's and the rest no longer agrees: the recipe moved
 * on since the draft was made from it.
 */
export async function sameLibraryRecipe(db: Db, content: ShippedRecipe): Promise<{ id: string } | 'changed' | null> {
  const held = await db.recipe.findFirst({ where: { ...OWN, slug: content.slug }, select: { id: true, title: true, description: true, steps: true, fingerprint: true } });
  if (!held) return null;
  const fingerprint = computeFingerprint({ ingredients: content.ingredients, mealTypes: content.mealTypes, servings: content.servings });
  const english = content.steps.en ?? [];
  const sameText = held.title === content.title.en && held.description === (content.description.en ?? '') && held.steps.length === english.length && held.steps.every((step, index) => step === english[index]);
  return held.fingerprint === fingerprint && sameText ? { id: held.id } : 'changed';
}

/**
 * Give the library's recipe `id` the text of `content` in every language but
 * English, stored as approved by people. Nothing else of the recipe is
 * written, and its English stays what it was.
 */
export async function addLanguages(tx: Db, id: string, content: ShippedRecipe): Promise<void> {
  for (const locale of Object.keys(content.title).filter((language) => language !== 'en')) {
    const text = {
      title: content.title[locale as keyof typeof content.title]!,
      description: content.description[locale as keyof typeof content.description] ?? '',
      steps: content.steps[locale as keyof typeof content.steps] ?? [],
      source: 'MANUAL' as const,
    };
    await tx.recipeTranslation.upsert({ where: { recipeId_locale: { recipeId: id, locale } }, create: { recipeId: id, locale, ...text }, update: text });
  }
}

/**
 * Of the approved `drafts`, those that may leave as a file for a repository's
 * data, and why the others may not. They are held to the terms of a recipe
 * that ships into this instance, against this instance's library and against
 * each other: the file is meant for the data this library was made from.
 */
export async function sortRecipesForFile<D extends RecipeDraftContent & ReviewedFacts & { id: string }>(
  db: Db,
  drafts: readonly D[],
): Promise<{ shipping: { draft: D; content: ShippedRecipe }[]; skipped: Skipped[] }> {
  const shipping: { draft: D; content: ShippedRecipe }[] = [];
  const skipped: Skipped[] = [];
  const claimed = nothingClaimed();
  for (const draft of drafts) {
    const shippable = shippableRecipe(draft);
    // A language for a recipe this instance has is the instance's to take: a file for a repository holds whole recipes.
    if (shippable.ok && (await sameLibraryRecipe(db, shippable.content)) !== null) {
      skipped.push({ draftId: draft.id, slug: draft.slug, reason: `adds-a-language: ${draft.slug}` });
      continue;
    }
    const assessed = shippable.ok ? await assessForLibrary(db, shippable.content, { reviewed: draft, claimed }) : shippable;
    if (assessed.ok) shipping.push({ draft, content: assessed.recipe.content });
    else skipped.push({ draftId: draft.id, slug: draft.slug, reason: assessed.reason });
  }
  return { shipping, skipped };
}
