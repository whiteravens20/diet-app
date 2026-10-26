// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The curated data as one checked value.
 *
 * Every seed file is read once, parsed, validated and cross-referenced here,
 * before anything is written to the database. The seeder and the data lint
 * both go through `readCatalogue`, so what the lint accepts is exactly what the
 * seeder can load, and a broken file stops an update while the database is
 * still untouched.
 */
import {
  Allergen,
  Cuisine,
  DietType,
  MealType,
  NaturalUnit,
  ProductCategory,
  ProteinKind,
  Unit,
  WebAddress,
  type RecipeDietTag,
} from '@diet-app/shared';
import { z } from 'zod';
import { recipeFacts, type FactsLine } from '../../engine/recipe-facts.js';
import { computeFingerprint } from '../drafts/fingerprint.js';
import { IngredientOverrideFile } from '../drafts/ship/ingredient-overrides.writer.js';
import { hashSeedInputs, readSeedInputs, resolveDataDir, type DataState } from './data-hash.js';

/** A human-readable field: a plain string, or one string per locale with `en` present. */
const localisedString = z.union([
  z.string().min(1),
  z.object({ en: z.string().min(1) }).catchall(z.string().min(1)),
]);
const localisedStringArray = z.union([
  z.array(z.string().min(1)).min(1),
  z.object({ en: z.array(z.string().min(1)).min(1) }).catchall(z.array(z.string().min(1)).min(1)),
]);
export type Localised<T extends string | string[]> = T | (Record<string, T> & { en: T });

const IngredientSeed = z.object({
  slug: z.string().min(1).optional(),
  name: localisedString,
  category: ProductCategory,
  canonicalUnit: Unit,
  caloriesPer100: z.number().min(0),
  proteinPer100: z.number().min(0),
  fatPer100: z.number().min(0),
  carbsPer100: z.number().min(0),
  // A zero factor would turn every converted quantity into zero or infinity.
  gramsPerPiece: z.number().positive().optional(),
  density: z.number().positive().optional(),
  // What a piece is called, for an ingredient that is counted instead of weighed.
  displayUnit: NaturalUnit.optional(),
  // How much a level teaspoon holds, in the canonical unit, for what is measured with one.
  perTeaspoon: z.number().positive().optional(),
  // The kind of protein it is, for the limits on one kind in a day and in seven days.
  proteinKind: ProteinKind.optional(),
  allergens: z.array(Allergen),
  dietCompatibility: z.array(DietType),
  tags: z.array(z.string()),
  // What one buys of it at a time, in the canonical unit; left out for what is bought loose.
  packSize: z.number().positive().optional(),
  // What is left of an opened pack does not keep for long.
  perishable: z.boolean().optional(),
  storageHint: localisedString.optional(),
  source: z.string().optional(),
  // The slugs under which a food import brings this same food: those rows are left out.
  importedAs: z.array(z.string().min(1)).optional(),
});
type IngredientSeed = z.infer<typeof IngredientSeed>;

const RecipeSeed = z.object({
  slug: z.string().min(1).optional(),
  title: localisedString,
  description: localisedString,
  servings: z.number().int().min(1),
  mealTypes: z.array(MealType).min(1),
  prepMinutes: z.number().int().min(0),
  cookMinutes: z.number().int().min(0),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  cuisine: Cuisine.optional(),
  ingredients: z
    .array(
      z
        .object({
          slug: z.string().min(1).optional(),
          name: z.string().min(1).optional(),
          quantity: z.number().min(0),
          unit: Unit,
          note: z.string().optional(),
        })
        .refine((line) => line.slug || line.name, {
          message: 'ingredient line needs either `slug` or `name`',
        }),
    )
    .min(1),
  steps: localisedStringArray,
  // Where a recipe that was taken in from somewhere else is from, and the licence it may be passed on under.
  source: z.object({ url: WebAddress.optional(), license: z.string().min(1).max(200) }).optional(),
});
type RecipeSeed = z.infer<typeof RecipeSeed>;

const SubstitutionSeed = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  note: localisedString.optional(),
});

/** An ingredient of the data, with the identity the database row is matched by. */
interface CatalogueIngredient extends IngredientSeed {
  slug: string;
  enName: string;
}

/** A recipe of the data with its ingredient lines resolved and its facts computed. */
interface CatalogueRecipe {
  slug: string;
  seed: RecipeSeed;
  lines: { slug: string; quantity: number; unit: Unit; note?: string }[];
  /** Per serving, computed from the ingredient table: never authored. */
  nutrition: { calories: number; protein: number; fat: number; carbs: number };
  allergens: string[];
  /** The diets the recipe qualifies for, worked out from its ingredients. */
  dietTags: RecipeDietTag[];
}

export interface Catalogue {
  ingredients: CatalogueIngredient[];
  recipes: CatalogueRecipe[];
  /** How many of `recipes` come from `recipes.json`; the rest are shipped batches. */
  anchorRecipes: number;
  substitutions: { from: string; to: string; note: string | null }[];
  /** How many foods of an import were left out because a curated ingredient is that food. */
  importedLeftOut: number;
  /** Friendly ingredient names by slug, applied on top of the curated names. */
  overrides: IngredientOverrideFile;
  /** Hash and sizes of the bytes this catalogue was read from. */
  state: DataState;
}

export interface CatalogueProblem {
  file: string;
  path: string;
  message: string;
}

/** The curated data cannot be loaded. `problems` names every file and path at fault. */
export class CatalogueError extends Error {
  constructor(readonly problems: CatalogueProblem[]) {
    super(
      `The curated data has ${problems.length} problem(s):\n` +
        problems.map((p) => `  ${p.file} ${p.path}: ${p.message}`).join('\n'),
    );
    this.name = 'CatalogueError';
  }
}

/** The English form of a localised field. */
export function en<T extends string | string[]>(value: Localised<T>): T {
  if (typeof value === 'string' || Array.isArray(value)) return value as T;
  return (value as { en: T }).en;
}

/** A localised field as `{ locale → value }`; a plain value counts as English. */
export function asLocaleMap<T extends string | string[]>(value: Localised<T>): Record<string, T> {
  if (typeof value === 'string' || Array.isArray(value)) return { en: value as T };
  return value as Record<string, T>;
}

/** Kebab-case ASCII identifier, the same one the USDA importer derives from a name. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Read and check the curated data in `dir`. Returns every problem found; the
 * catalogue is present only when there is none.
 */
export function readCatalogue(dir: string = resolveDataDir()): {
  catalogue: Catalogue | null;
  problems: CatalogueProblem[];
} {
  const inputs = readSeedInputs(dir);
  const problems: CatalogueProblem[] = [];

  const parse = (file: string, bytes: Buffer | null | undefined, optional: boolean): unknown => {
    if (!bytes) {
      if (!optional) problems.push({ file, path: '<missing>', message: 'file not found' });
      return undefined;
    }
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (err) {
      problems.push({ file, path: '<root>', message: `invalid JSON: ${(err as Error).message}` });
      return undefined;
    }
  };

  const rows = <T>(file: string, raw: unknown, schema: z.ZodType<T>): T[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      problems.push({ file, path: '<root>', message: 'expected a top-level JSON array' });
      return [];
    }
    const out: T[] = [];
    raw.forEach((row, i) => {
      const result = schema.safeParse(row);
      if (result.success) {
        out.push(result.data);
        return;
      }
      for (const issue of result.error.issues) {
        const path = `[${i}]${issue.path.length ? `.${issue.path.join('.')}` : ''}`;
        problems.push({ file, path, message: issue.message });
      }
    });
    return out;
  };

  // ── ingredients: curated first, imported ones fill in what curated lacks ────
  const identity = (row: IngredientSeed) => row.slug ?? slugify(en(row.name));
  const withinFile = (file: string, list: IngredientSeed[]) => {
    const seen = new Set<string>();
    list.forEach((row, i) => {
      const key = identity(row);
      if (seen.has(key))
        problems.push({ file, path: `[${i}]`, message: `duplicate ingredient "${key}"` });
      seen.add(key);
    });
  };
  const curated = rows(
    'ingredients.json',
    parse('ingredients.json', inputs.files.get('ingredients.json'), false),
    IngredientSeed,
  );
  const generated = rows(
    'ingredients.generated.json',
    parse('ingredients.generated.json', inputs.files.get('ingredients.generated.json'), true),
    IngredientSeed,
  );
  withinFile('ingredients.json', curated);
  withinFile('ingredients.generated.json', generated);
  // An ingredient can only be counted in pieces when a piece has a weight, and only a pack can be one that does not keep.
  for (const [file, list] of [
    ['ingredients.json', curated],
    ['ingredients.generated.json', generated],
  ] as const) {
    list.forEach((row, i) => {
      if (row.displayUnit && row.gramsPerPiece === undefined) {
        problems.push({
          file,
          path: `[${i}].displayUnit`,
          message: `"${identity(row)}" is counted in ${row.displayUnit}s but has no gramsPerPiece`,
        });
      }
      // A teaspoon holds a weight or a volume, and what is counted in pieces is not measured with one.
      if (row.perTeaspoon !== undefined && (row.canonicalUnit === 'piece' || row.displayUnit)) {
        problems.push({
          file,
          path: `[${i}].perTeaspoon`,
          message: `"${identity(row)}" is measured with a teaspoon but is ${row.displayUnit ? `counted in ${row.displayUnit}s` : 'kept in pieces'}`,
        });
      }
      // It is the pack that is opened and left: an ingredient without one has nothing to leave.
      if (row.perishable && row.packSize === undefined) {
        problems.push({
          file,
          path: `[${i}].perishable`,
          message: `"${identity(row)}" is marked as a pack that does not keep but has no packSize`,
        });
      }
    });
  }

  // A food the catalogue has under a name of its own is not taken from an
  // import a second time: the pantry, a shopping list and a plan would count
  // the two rows as two foods, each with figures of its own.
  const standsFor = new Map<string, string>();
  const curatedSlugs = new Set(curated.map(identity));
  curated.forEach((row, i) => {
    for (const imported of row.importedAs ?? []) {
      const taken = standsFor.get(imported);
      if (curatedSlugs.has(imported)) {
        problems.push({
          file: 'ingredients.json',
          path: `[${i}].importedAs`,
          message: `"${imported}" is an ingredient of this file, not a food of an import`,
        });
      } else if (taken !== undefined) {
        problems.push({
          file: 'ingredients.json',
          path: `[${i}].importedAs`,
          message: `"${imported}" is named by "${taken}" as well`,
        });
      } else {
        standsFor.set(imported, identity(row));
      }
    }
  });

  const bySlug = new Map<string, CatalogueIngredient>();
  const byName = new Map<string, CatalogueIngredient>();
  let importedLeftOut = 0;
  for (const row of [...curated, ...generated]) {
    const slug = identity(row);
    if (bySlug.has(slug)) continue;
    const curatedAs = bySlug.get(standsFor.get(slug) ?? '');
    if (curatedAs) {
      // What a recipe from elsewhere calls the imported food means the curated one.
      importedLeftOut += 1;
      const name = en(row.name).toLowerCase();
      if (!byName.has(name)) byName.set(name, curatedAs);
      continue;
    }
    const ingredient = { ...row, slug, enName: en(row.name) };
    bySlug.set(slug, ingredient);
    byName.set(ingredient.enName.toLowerCase(), ingredient);
  }
  const find = (ref: string) =>
    bySlug.get(ref) ?? bySlug.get(standsFor.get(ref) ?? '') ?? byName.get(ref.toLowerCase());

  // ── recipes: the anchor file, then every shipped batch in filename order ────
  const recipeFiles: { file: string; seeds: RecipeSeed[] }[] = [
    {
      file: 'recipes.json',
      seeds: rows(
        'recipes.json',
        parse('recipes.json', inputs.files.get('recipes.json'), false),
        RecipeSeed,
      ),
    },
    ...inputs.batches.map((batch) => ({
      file: batch.path,
      seeds: rows(batch.path, parse(batch.path, batch.bytes, false), RecipeSeed),
    })),
  ];
  const recipes: CatalogueRecipe[] = [];
  const recipeSlugs = new Map<string, string>();
  const recipeTitles = new Map<string, string>();
  const recipeMakings = new Map<string, { slug: string; file: string }>();
  for (const { file, seeds } of recipeFiles) {
    seeds.forEach((seed, i) => {
      const title = en(seed.title);
      const slug = seed.slug ?? slugify(title);
      const firstSlug = recipeSlugs.get(slug);
      const firstTitle = recipeTitles.get(title.toLowerCase());
      if (firstSlug)
        problems.push({
          file,
          path: `[${i}].slug`,
          message: `recipe "${slug}" is also in ${firstSlug}`,
        });
      else if (firstTitle)
        problems.push({
          file,
          path: `[${i}].title`,
          message: `title "${title}" is also in ${firstTitle}`,
        });
      recipeSlugs.set(slug, file);
      recipeTitles.set(title.toLowerCase(), file);

      const lines: CatalogueRecipe['lines'] = [];
      const factLines: FactsLine[] = [];
      seed.ingredients.forEach((line, j) => {
        const ref = line.slug ?? line.name!;
        const ingredient = find(ref);
        const path = `[${i}].ingredients[${j}]`;
        if (!ingredient) {
          problems.push({ file, path, message: `unknown ingredient "${ref}"` });
          return;
        }
        const factLine: FactsLine = {
          quantity: line.quantity,
          unit: line.unit,
          ingredient: {
            ...ingredient,
            gramsPerPiece: ingredient.gramsPerPiece ?? null,
            density: ingredient.density ?? null,
          },
        };
        try {
          // Checked line by line, so that a unit that cannot be converted is
          // reported where it is written.
          recipeFacts([factLine], 1);
        } catch (err) {
          problems.push({
            file,
            path,
            message: `"${ref}" in ${line.unit}: ${(err as Error).message}`,
          });
          return;
        }
        factLines.push(factLine);
        lines.push({
          slug: ingredient.slug,
          quantity: line.quantity,
          unit: line.unit,
          ...(line.note ? { note: line.note } : {}),
        });
      });

      // One dish under two names would be planned as two, and a recipe a user
      // writes is recognised as only one of them.
      if (lines.length === seed.ingredients.length) {
        const making = computeFingerprint({
          ingredients: lines,
          mealTypes: seed.mealTypes,
          servings: seed.servings,
        });
        const first = recipeMakings.get(making);
        if (first) {
          problems.push({
            file,
            path: `[${i}]`,
            message: `recipe "${slug}" is made of the same as "${first.slug}" in ${first.file}: same ingredients and amounts, meals and servings`,
          });
        } else recipeMakings.set(making, { slug, file });
      }

      const facts = recipeFacts(factLines, seed.servings);
      recipes.push({
        slug,
        seed,
        lines,
        nutrition: facts.perServing,
        allergens: facts.allergens,
        dietTags: facts.dietTags,
      });
    });
  }

  // ── substitutions and name overrides ────────────────────────────────────────
  const substitutions: Catalogue['substitutions'] = [];
  rows(
    'substitutions.json',
    parse('substitutions.json', inputs.files.get('substitutions.json'), false),
    SubstitutionSeed,
  ).forEach((sub, i) => {
    const from = find(sub.from);
    const to = find(sub.to);
    if (!from)
      problems.push({
        file: 'substitutions.json',
        path: `[${i}].from`,
        message: `unknown ingredient "${sub.from}"`,
      });
    if (!to)
      problems.push({
        file: 'substitutions.json',
        path: `[${i}].to`,
        message: `unknown ingredient "${sub.to}"`,
      });
    if (from && to)
      substitutions.push({ from: from.slug, to: to.slug, note: sub.note ? en(sub.note) : null });
  });

  let overrides: IngredientOverrideFile = {};
  const rawOverrides = parse(
    'ingredient-overrides.json',
    inputs.files.get('ingredient-overrides.json'),
    true,
  );
  if (rawOverrides !== undefined) {
    const parsed = IngredientOverrideFile.safeParse(rawOverrides);
    if (parsed.success) overrides = parsed.data;
    else {
      for (const issue of parsed.error.issues) {
        problems.push({
          file: 'ingredient-overrides.json',
          path: issue.path.join('.') || '<root>',
          message: issue.message,
        });
      }
    }
  }

  if (problems.length > 0) return { catalogue: null, problems };
  return {
    catalogue: {
      ingredients: [...bySlug.values()],
      recipes,
      anchorRecipes: recipeFiles[0]!.seeds.length,
      substitutions,
      importedLeftOut,
      overrides,
      state: hashSeedInputs(inputs),
    },
    problems,
  };
}

/** Read the curated data, or throw a `CatalogueError` that lists what is wrong with it. */
export function loadCatalogue(dir: string = resolveDataDir()): Catalogue {
  const { catalogue, problems } = readCatalogue(dir);
  if (!catalogue) throw new CatalogueError(problems);
  return catalogue;
}
