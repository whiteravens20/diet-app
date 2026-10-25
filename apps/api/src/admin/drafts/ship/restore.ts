// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Restoring what an instance added to its catalogue, from the files it wrote.
 *
 * Shipping into the instance copies every recipe and every name it ships to
 * the instance's data directory, in the shape of the catalogue's data files
 * (`local-mode.ts`). This reads those files back: on a new server, after the
 * catalogue's own data is in, it brings the instance's recipes and names with
 * it, without the old database.
 *
 * It can be run again at any time. A recipe the library does not have is
 * added; one it has, under the same slug, is written over from the file and
 * keeps its id, so plans that use it go on working. The files are read in the
 * order of their names, which is the order they were written in, so of two
 * files that hold the same slug the later one counts.
 *
 * A file is no more trusted than a draft: each recipe is held to the rules of
 * every recipe and to the terms of the library (`library.ts`), each name to
 * the rules for names. What does not pass is left out and reported; it never
 * stops the rest.
 */
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { holdCatalogue } from '../../seed/seeder.js';
import {
  IngredientOverrideFile,
  ingredientOverridesPath,
  INGREDIENT_OVERRIDES_FILE,
} from './ingredient-overrides.writer.js';
import { assessForLibrary, writeToLibrary } from './library.js';
import { applyOverridesToDb } from './pull-overrides.js';
import { recipeBatchesDir, RECIPE_BATCHES_DIR } from './recipe-batches.writer.js';
import { recipeOfBatchRow } from './shippable.js';

/** What the instance's data directory holds, as far as it can be read. */
export interface InstanceDataState {
  /** Whether the API can write there: a ship that cannot leaves no copy to restore from. */
  writable: boolean;
  recipeFiles: number;
  recipes: number;
  names: number;
}

export interface RestoreResult {
  recipes: {
    added: number;
    rewritten: number;
    /** Recipes left out, with the file they are in and the reason as a skipped draft carries one. */
    skipped: { file: string; slug: string; reason: string }[];
  };
  names: {
    applied: number;
    /** Names for ingredients the catalogue does not have. */
    skippedSlugs: string[];
    /** Names that break a rule, with the reason. */
    refused: { slug: string; reason: string }[];
  };
  /** Files that could not be read at all, with the reason. */
  unreadable: { file: string; reason: string }[];
}

interface BatchFile {
  /** As a path inside the data directory: `recipes/<name>.json`. */
  file: string;
  rows: unknown[];
}

/** The recipe batches of the directory in the order of their names, and the files that are none. */
function readBatches(instanceDataDir: string): {
  batches: BatchFile[];
  unreadable: RestoreResult['unreadable'];
} {
  const dir = recipeBatchesDir(instanceDataDir);
  const batches: BatchFile[] = [];
  const unreadable: RestoreResult['unreadable'] = [];
  if (!existsSync(dir)) return { batches, unreadable };
  for (const name of readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    const file = `${RECIPE_BATCHES_DIR}/${name}`;
    try {
      const rows: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (Array.isArray(rows)) batches.push({ file, rows });
      else unreadable.push({ file, reason: 'not-a-batch' });
    } catch {
      unreadable.push({ file, reason: 'not-json' });
    }
  }
  return { batches, unreadable };
}

/** The names of the directory's override file; none when there is no file. */
function readNames(instanceDataDir: string): {
  names: IngredientOverrideFile;
  unreadable: RestoreResult['unreadable'];
} {
  const path = ingredientOverridesPath(instanceDataDir);
  if (!existsSync(path)) return { names: {}, unreadable: [] };
  try {
    const parsed = IngredientOverrideFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (parsed.success) return { names: parsed.data, unreadable: [] };
    return {
      names: {},
      unreadable: [{ file: INGREDIENT_OVERRIDES_FILE, reason: 'not-an-override-file' }],
    };
  } catch {
    return { names: {}, unreadable: [{ file: INGREDIENT_OVERRIDES_FILE, reason: 'not-json' }] };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the directory holds now. Nothing is created or changed by asking. */
export function instanceDataState(instanceDataDir: string): InstanceDataState {
  const { batches } = readBatches(instanceDataDir);
  // A directory that is not there yet is made by the first ship, if its parent lets it.
  const target = existsSync(instanceDataDir) ? instanceDataDir : dirname(instanceDataDir);
  let writable = true;
  try {
    accessSync(target, constants.W_OK);
  } catch {
    writable = false;
  }
  return {
    writable,
    recipeFiles: batches.length,
    recipes: batches.reduce((sum, batch) => sum + batch.rows.length, 0),
    names: Object.keys(readNames(instanceDataDir).names).length,
  };
}

/** Read the instance's files back into the database. */
export async function restoreInstanceData(
  prisma: PrismaService,
  instanceDataDir: string,
): Promise<RestoreResult> {
  const { batches, unreadable } = readBatches(instanceDataDir);
  const recipes: RestoreResult['recipes'] = { added: 0, rewritten: 0, skipped: [] };

  for (const { file, rows } of batches) {
    for (const [index, row] of rows.entries()) {
      const named = isRecord(row) && typeof row.slug === 'string' ? row.slug : `[${index}]`;
      const shippable = recipeOfBatchRow(row);
      if (!shippable.ok) {
        recipes.skipped.push({ file, slug: named, reason: shippable.reason });
        continue;
      }
      const content = shippable.content;
      const outcome = await prisma.$transaction(async (tx) => {
        await holdCatalogue(tx);
        // The library's own recipe of this slug is written over; anybody
        // else's slug (a recipe of the catalogue's data) is not taken.
        const mine = await tx.recipe.findFirst({
          where: { slug: content.slug, createdByUserId: null, origin: { not: 'seed' } },
          select: { id: true },
        });
        const assessed = await assessForLibrary(tx, content, { own: mine?.id });
        if (!assessed.ok) return assessed.reason;
        await writeToLibrary(tx, assessed.recipe, mine?.id);
        return mine ? ('rewritten' as const) : ('added' as const);
      });
      if (outcome === 'added' || outcome === 'rewritten') recipes[outcome] += 1;
      else recipes.skipped.push({ file, slug: content.slug, reason: outcome });
    }
  }

  const fromFile = readNames(instanceDataDir);
  const applied = await applyOverridesToDb(prisma, fromFile.names);
  return {
    recipes,
    names: {
      applied: applied.applied,
      skippedSlugs: applied.skippedSlugs,
      refused: applied.refused,
    },
    unreadable: [...unreadable, ...fromFile.unreadable],
  };
}
