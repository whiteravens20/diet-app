// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The instance's own files, written from its database. They hold what the
 * instance's library has that the catalogue's data does not, in the shape of
 * the catalogue's data files, and the version of the application that wrote
 * them:
 *
 *  - `recipes/library.json`: every recipe of the instance's own library
 *    (`origin: curated`), in the order of their slugs, each with its lines in
 *    their order;
 *  - `ingredient-overrides.json`: the names of ingredients this instance
 *    gave, without those the catalogue's data gives as they are;
 *  - `manifest.json`: the version of the application, and how many recipes
 *    and names the files hold.
 *
 * They are written again after every ship into the instance, every restore
 * and every update of the catalogue, so they say what the database says, in
 * the shape the running version writes. A restore refuses files that a newer
 * version wrote (`restore.ts`).
 *
 * The directory may still hold files of the earlier layout, one
 * `recipes/<batch>.json` for each ship. Once every recipe in one of them is in
 * the library, the file says nothing the export does not, and it is removed.
 * While one holds a recipe the library does not have (the files of another
 * server, not yet restored), or cannot be read, nothing is written: the
 * export would leave that recipe out.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { buildCurrentIngredientOverrides } from './current-overrides.js';
import {
  INGREDIENT_OVERRIDES_FILE,
  ingredientOverridesPath,
  readIngredientOverrides,
  type IngredientOverrideFile,
} from './ingredient-overrides.writer.js';
import {
  recipeBatchesDir,
  RECIPE_BATCHES_DIR,
  type ShippedRecipe,
} from './recipe-batches.writer.js';

/** The file of the instance's library, among the recipe files of its directory. */
const LIBRARY_FILE = 'library.json';
const MANIFEST_FILE = 'manifest.json';

/** What the manifest says: which version wrote the files, and how much they hold. */
export const InstanceManifest = z.object({
  app: z.literal('diet-app'),
  version: z.string().min(1).max(40),
  recipes: z.number().int().min(0),
  names: z.number().int().min(0),
});
export type InstanceManifest = z.infer<typeof InstanceManifest>;

/** A file of the earlier layout that holds what the library does not. */
export interface NotRestored {
  /** As a path inside the data directory: `recipes/<name>.json`. */
  file: string;
  /** The slugs the library does not have; none when the file cannot be read at all. */
  slugs: string[];
}

export interface InstanceExport {
  /** The files written, as paths inside the data directory. */
  written: string[];
  /** The files of the earlier layout that were removed, every recipe of theirs being in the library. */
  removed: string[];
  /** Why nothing was written: files that hold recipes the library does not have. */
  notRestored: NotRestored[];
}

/** The manifest of the directory; null where there is none, or none that can be read. */
export function readManifest(instanceDataDir: string): InstanceManifest | null {
  const path = join(instanceDataDir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = InstanceManifest.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** When the manifest, the last of the files to be written, was written; null where there is none. */
export function manifestWrittenAt(instanceDataDir: string): Date | null {
  const path = join(instanceDataDir, MANIFEST_FILE);
  return existsSync(path) ? statSync(path).mtime : null;
}

/** The recipe files of the earlier layout, by their names inside the recipes directory. */
function earlierFiles(instanceDataDir: string): string[] {
  const dir = recipeBatchesDir(instanceDataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== LIBRARY_FILE)
    .sort();
}

/** Of the files of the earlier layout, those that hold what the library does not have. */
export async function notRestored(
  prisma: PrismaService,
  instanceDataDir: string,
): Promise<NotRestored[]> {
  const files = earlierFiles(instanceDataDir);
  if (files.length === 0) return [];
  const slugsOf = new Map<string, string[]>();
  const waiting: NotRestored[] = [];
  for (const name of files) {
    const file = `${RECIPE_BATCHES_DIR}/${name}`;
    let rows: unknown;
    try {
      rows = JSON.parse(readFileSync(join(recipeBatchesDir(instanceDataDir), name), 'utf8'));
    } catch {
      waiting.push({ file, slugs: [] });
      continue;
    }
    if (!Array.isArray(rows)) {
      waiting.push({ file, slugs: [] });
      continue;
    }
    slugsOf.set(
      file,
      rows.flatMap((row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { slug?: unknown }).slug === 'string'
          ? [(row as { slug: string }).slug]
          : [],
      ),
    );
  }
  const asked = [...new Set([...slugsOf.values()].flat())];
  const held = new Set(
    (
      await prisma.recipe.findMany({
        where: { ...LIBRARY, slug: { in: asked } },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );
  for (const [file, slugs] of slugsOf) {
    const missing = slugs.filter((slug) => !held.has(slug));
    if (missing.length > 0) waiting.push({ file, slugs: missing });
  }
  return waiting.sort((a, b) => a.file.localeCompare(b.file));
}

/** The recipes of the instance's own library, which a ship or a restore wrote. */
const LIBRARY = {
  origin: 'curated',
  createdByUserId: null,
  deletedAt: null,
  retiredAt: null,
} as const;

/** Every recipe of the instance's own library, as a row of the catalogue's data files. */
async function libraryRows(prisma: PrismaService): Promise<ShippedRecipe[]> {
  const recipes = await prisma.recipe.findMany({
    where: { ...LIBRARY, slug: { not: null } },
    orderBy: { slug: 'asc' },
    include: {
      translations: { orderBy: { locale: 'asc' } },
      ingredients: {
        orderBy: { position: 'asc' },
        include: { ingredient: { select: { slug: true } } },
      },
    },
  });
  return recipes.map((recipe) => {
    // The row's own text is English; a translation of a language, English too, stands for it.
    const texts = [{ locale: 'en', ...recipe }, ...recipe.translations];
    const byLocale = <T>(pick: (text: (typeof texts)[number]) => T): Record<string, T> =>
      Object.fromEntries(texts.map((text) => [text.locale, pick(text)]));
    return {
      slug: recipe.slug!,
      title: byLocale((text) => text.title),
      description: byLocale((text) => text.description),
      servings: recipe.servings,
      mealTypes: recipe.mealTypes as ShippedRecipe['mealTypes'],
      prepMinutes: recipe.prepMinutes,
      cookMinutes: recipe.cookMinutes,
      difficulty: recipe.difficulty,
      ...(recipe.cuisine ? { cuisine: recipe.cuisine as ShippedRecipe['cuisine'] } : {}),
      ingredients: recipe.ingredients.map((line) => ({
        slug: line.ingredient.slug!,
        quantity: line.quantity,
        unit: line.unit,
        ...(line.note ? { note: line.note } : {}),
      })),
      steps: byLocale((text) => text.steps),
      ...(recipe.sourceLicense
        ? {
            source: {
              ...(recipe.sourceUrl ? { url: recipe.sourceUrl } : {}),
              license: recipe.sourceLicense,
            },
          }
        : {}),
    };
  });
}

/** Of the names the database holds, the languages in which they are not what the catalogue's data says. */
export function namesOfTheInstance(
  held: IngredientOverrideFile,
  catalogue: IngredientOverrideFile,
): IngredientOverrideFile {
  const own: IngredientOverrideFile = {};
  for (const [slug, entry] of Object.entries(held)) {
    const theirs = catalogue[slug];
    const names: Record<string, string | undefined> = entry.name;
    const hints: Record<string, string | undefined> = entry.storageHint ?? {};
    const theirNames: Record<string, string | undefined> = theirs?.name ?? {};
    const theirHints: Record<string, string | undefined> = theirs?.storageHint ?? {};
    const locales = Object.keys(names).filter(
      (locale) =>
        names[locale] !== theirNames[locale] ||
        (hints[locale] ?? null) !== (theirHints[locale] ?? null),
    );
    if (locales.length === 0) continue;
    const pick = (map: Record<string, string | undefined>) =>
      Object.fromEntries(
        locales.flatMap((locale) => (map[locale] === undefined ? [] : [[locale, map[locale]!]])),
      );
    const hint = pick(hints);
    own[slug] = {
      name: pick(names),
      ...(Object.keys(hint).length > 0 ? { storageHint: hint } : {}),
    };
  }
  return own;
}

/** Write a file whole or not at all: a reader never finds half of it. */
function writeWhole(path: string, value: unknown): void {
  const partial = `${path}.writing`;
  writeFileSync(partial, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(partial, path);
}

/**
 * Write the instance's files from its database. Nothing is written while the
 * directory holds files of the earlier layout with recipes the library does
 * not have; the answer names them.
 */
export async function exportInstanceData(
  prisma: PrismaService,
  instanceDataDir: string,
  version: string,
  seedDataDir: string,
): Promise<InstanceExport> {
  const waiting = await notRestored(prisma, instanceDataDir);
  if (waiting.length > 0) return { written: [], removed: [], notRestored: waiting };
  const earlier = earlierFiles(instanceDataDir);

  const recipes = await libraryRows(prisma);
  const names = namesOfTheInstance(
    await buildCurrentIngredientOverrides(prisma),
    // The names of the catalogue's own data are left out: the catalogue gives them.
    readIngredientOverrides(join(seedDataDir, INGREDIENT_OVERRIDES_FILE)),
  );
  const manifest: InstanceManifest = {
    app: 'diet-app',
    version,
    recipes: recipes.length,
    names: Object.keys(names).length,
  };

  mkdirSync(recipeBatchesDir(instanceDataDir), { recursive: true });
  writeWhole(join(recipeBatchesDir(instanceDataDir), LIBRARY_FILE), recipes);
  writeWhole(ingredientOverridesPath(instanceDataDir), names);
  writeWhole(join(instanceDataDir, MANIFEST_FILE), manifest);
  for (const name of earlier) rmSync(join(recipeBatchesDir(instanceDataDir), name));

  return {
    written: [`${RECIPE_BATCHES_DIR}/${LIBRARY_FILE}`, INGREDIENT_OVERRIDES_FILE, MANIFEST_FILE],
    removed: earlier.map((name) => `${RECIPE_BATCHES_DIR}/${name}`),
    notRestored: [],
  };
}

/**
 * Whether files that `written` wrote may be read by the running `version`: a
 * newer version may have written what this one does not know. Versions that
 * are not three numbers cannot be told apart, and do not stand in the way.
 */
export function readableBy(version: string, written: string): boolean {
  const parts = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const running = parts(version);
  const writer = parts(written);
  if (!running || !writer) return true;
  for (let index = 0; index < 3; index += 1) {
    if (writer[index]! !== running[index]!) return writer[index]! < running[index]!;
  }
  return true;
}
