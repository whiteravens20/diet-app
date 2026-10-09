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
import { Allergen, DietType, MealType, ProductCategory, Unit } from '@diet-app/shared';
import { z } from 'zod';
import { nutritionFor, toCanonical } from '../../engine/units.js';
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
  allergens: z.array(Allergen),
  dietCompatibility: z.array(DietType),
  tags: z.array(z.string()),
  packSize: z.number().min(0).optional(),
  storageHint: localisedString.optional(),
  source: z.string().optional(),
});
type IngredientSeed = z.infer<typeof IngredientSeed>;

const RecipeSeed = z.object({
  slug: z.string().min(1).optional(),
  title: localisedString,
  description: localisedString,
  servings: z.number().int().min(1),
  mealTypes: z.array(MealType).min(1),
  dietTags: z.array(DietType),
  prepMinutes: z.number().int().min(0),
  cookMinutes: z.number().int().min(0),
  difficulty: z.enum(['easy', 'medium', 'hard']),
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
        .refine((line) => line.slug || line.name, { message: 'ingredient line needs either `slug` or `name`' }),
    )
    .min(1),
  steps: localisedStringArray,
});
type RecipeSeed = z.infer<typeof RecipeSeed>;

const SubstitutionSeed = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  note: localisedString.optional(),
});

/** An ingredient of the data, with the identity the database row is matched by. */
export interface CatalogueIngredient extends IngredientSeed {
  slug: string;
  enName: string;
}

/** A recipe of the data with its ingredient lines resolved and its facts computed. */
export interface CatalogueRecipe {
  slug: string;
  seed: RecipeSeed;
  lines: { slug: string; quantity: number; unit: Unit; note?: string }[];
  /** Per serving, computed from the ingredient table: never authored. */
  nutrition: { calories: number; protein: number; fat: number; carbs: number };
  allergens: string[];
}

export interface Catalogue {
  ingredients: CatalogueIngredient[];
  recipes: CatalogueRecipe[];
  /** How many of `recipes` come from `recipes.json`; the rest are shipped batches. */
  anchorRecipes: number;
  substitutions: { from: string; to: string; note: string | null }[];
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
      if (seen.has(key)) problems.push({ file, path: `[${i}]`, message: `duplicate ingredient "${key}"` });
      seen.add(key);
    });
  };
  const curated = rows('ingredients.json', parse('ingredients.json', inputs.files.get('ingredients.json'), false), IngredientSeed);
  const generated = rows(
    'ingredients.generated.json',
    parse('ingredients.generated.json', inputs.files.get('ingredients.generated.json'), true),
    IngredientSeed,
  );
  withinFile('ingredients.json', curated);
  withinFile('ingredients.generated.json', generated);

  const bySlug = new Map<string, CatalogueIngredient>();
  const byName = new Map<string, CatalogueIngredient>();
  for (const row of [...curated, ...generated]) {
    const slug = identity(row);
    if (bySlug.has(slug)) continue;
    const ingredient = { ...row, slug, enName: en(row.name) };
    bySlug.set(slug, ingredient);
    byName.set(ingredient.enName.toLowerCase(), ingredient);
  }
  const find = (ref: string) => bySlug.get(ref) ?? byName.get(ref.toLowerCase());

  // ── recipes: the anchor file, then every shipped batch in filename order ────
  const recipeFiles: { file: string; seeds: RecipeSeed[] }[] = [
    { file: 'recipes.json', seeds: rows('recipes.json', parse('recipes.json', inputs.files.get('recipes.json'), false), RecipeSeed) },
    ...inputs.batches.map((batch) => ({
      file: batch.path,
      seeds: rows(batch.path, parse(batch.path, batch.bytes, false), RecipeSeed),
    })),
  ];
  const recipes: CatalogueRecipe[] = [];
  const recipeSlugs = new Map<string, string>();
  const recipeTitles = new Map<string, string>();
  for (const { file, seeds } of recipeFiles) {
    seeds.forEach((seed, i) => {
      const title = en(seed.title);
      const slug = seed.slug ?? slugify(title);
      const firstSlug = recipeSlugs.get(slug);
      const firstTitle = recipeTitles.get(title.toLowerCase());
      if (firstSlug) problems.push({ file, path: `[${i}].slug`, message: `recipe "${slug}" is also in ${firstSlug}` });
      else if (firstTitle) problems.push({ file, path: `[${i}].title`, message: `title "${title}" is also in ${firstTitle}` });
      recipeSlugs.set(slug, file);
      recipeTitles.set(title.toLowerCase(), file);

      const total = { calories: 0, protein: 0, fat: 0, carbs: 0 };
      const allergens = new Set<string>();
      const lines: CatalogueRecipe['lines'] = [];
      seed.ingredients.forEach((line, j) => {
        const ref = line.slug ?? line.name!;
        const ingredient = find(ref);
        const path = `[${i}].ingredients[${j}]`;
        if (!ingredient) {
          problems.push({ file, path, message: `unknown ingredient "${ref}"` });
          return;
        }
        try {
          const canonical = toCanonical(line.quantity, line.unit, {
            canonicalUnit: ingredient.canonicalUnit,
            gramsPerPiece: ingredient.gramsPerPiece ?? null,
            density: ingredient.density ?? null,
          });
          const n = nutritionFor(canonical, {
            calories: ingredient.caloriesPer100,
            protein: ingredient.proteinPer100,
            fat: ingredient.fatPer100,
            carbs: ingredient.carbsPer100,
          });
          total.calories += n.calories;
          total.protein += n.protein;
          total.fat += n.fat;
          total.carbs += n.carbs;
        } catch (err) {
          problems.push({ file, path, message: `"${ref}" in ${line.unit}: ${(err as Error).message}` });
          return;
        }
        ingredient.allergens.forEach((a) => allergens.add(a));
        lines.push({ slug: ingredient.slug, quantity: line.quantity, unit: line.unit, ...(line.note ? { note: line.note } : {}) });
      });

      recipes.push({
        slug,
        seed,
        lines,
        nutrition: {
          calories: Math.round(total.calories / seed.servings),
          protein: Math.round(total.protein / seed.servings),
          fat: Math.round(total.fat / seed.servings),
          carbs: Math.round(total.carbs / seed.servings),
        },
        allergens: [...allergens],
      });
    });
  }

  // ── substitutions and name overrides ────────────────────────────────────────
  const substitutions: Catalogue['substitutions'] = [];
  rows('substitutions.json', parse('substitutions.json', inputs.files.get('substitutions.json'), false), SubstitutionSeed).forEach(
    (sub, i) => {
      const from = find(sub.from);
      const to = find(sub.to);
      if (!from) problems.push({ file: 'substitutions.json', path: `[${i}].from`, message: `unknown ingredient "${sub.from}"` });
      if (!to) problems.push({ file: 'substitutions.json', path: `[${i}].to`, message: `unknown ingredient "${sub.to}"` });
      if (from && to) substitutions.push({ from: from.slug, to: to.slug, note: sub.note ? en(sub.note) : null });
    },
  );

  let overrides: IngredientOverrideFile = {};
  const rawOverrides = parse('ingredient-overrides.json', inputs.files.get('ingredient-overrides.json'), true);
  if (rawOverrides !== undefined) {
    const parsed = IngredientOverrideFile.safeParse(rawOverrides);
    if (parsed.success) overrides = parsed.data;
    else {
      for (const issue of parsed.error.issues) {
        problems.push({ file: 'ingredient-overrides.json', path: issue.path.join('.') || '<root>', message: issue.message });
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
