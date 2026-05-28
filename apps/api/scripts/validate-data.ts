/**
 * Validate the curated seed-data JSON files (`data/*.json`) against Zod schemas
 * derived from `@diet-app/shared`. Runs in CI on every push so a malformed
 * import or a hand edit can't poison the seed pipeline.
 *
 * Checks per file:
 *   - ingredients.json + ingredients.generated.json (if present): one
 *     `IngredientSeed` per row, enum-valid category / allergens / diet tags,
 *     unique names across both files combined.
 *   - recipes.json: anchor recipes, with every ingredient line referencing an
 *     ingredient that exists in the merged ingredient set.
 *   - substitutions.json: both `from` and `to` resolve to known ingredients.
 *
 * Exits non-zero on any failure with a per-issue path/message report.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Allergen, DietType, MealType, ProductCategory, Unit } from '@diet-app/shared';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');

// Seed-input shapes. Mirror the runtime `Localised<T>` contract in
// `apps/api/src/admin/seed/seeder.ts`: every human-readable field is either a
// bare string (legacy / composer output) OR a per-locale object that MUST
// carry an `en` key. The seeder normalises both into translation-table rows.
const localisedString = z.union([
  z.string().min(1),
  z.object({ en: z.string().min(1) }).catchall(z.string().min(1)),
]);
const localisedStringArray = z.union([
  z.array(z.string().min(1)).min(1),
  z
    .object({ en: z.array(z.string().min(1)).min(1) })
    .catchall(z.array(z.string().min(1)).min(1)),
]);

const IngredientSeed = z.object({
  slug: z.string().min(1).optional(),
  name: localisedString,
  category: ProductCategory,
  canonicalUnit: Unit,
  caloriesPer100: z.number().min(0),
  proteinPer100: z.number().min(0),
  fatPer100: z.number().min(0),
  carbsPer100: z.number().min(0),
  gramsPerPiece: z.number().min(0).optional(),
  density: z.number().min(0).optional(),
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
        .refine((l) => l.slug || l.name, {
          message: 'ingredient line needs either `slug` or `name`',
        }),
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

/** Pull the canonical English string out of a Localised<string> for indexing
 *  + diagnostics. Mirrors the seeder's `pickEnglish()`. */
function en(value: string | { en: string }): string {
  return typeof value === 'string' ? value : value.en;
}

interface Failure {
  file: string;
  path: string;
  message: string;
}
const failures: Failure[] = [];

function readJsonArray<T>(file: string, schema: z.ZodType<T>, optional = false): T[] {
  const fullPath = join(dataDir, file);
  if (!existsSync(fullPath)) {
    if (optional) return [];
    failures.push({ file, path: '<missing>', message: 'file not found' });
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (err) {
    failures.push({ file, path: '<root>', message: `invalid JSON: ${(err as Error).message}` });
    return [];
  }
  if (!Array.isArray(parsed)) {
    failures.push({ file, path: '<root>', message: 'expected a top-level JSON array' });
    return [];
  }
  const out: T[] = [];
  parsed.forEach((row, i) => {
    const result = schema.safeParse(row);
    if (!result.success) {
      for (const issue of result.error.issues) {
        failures.push({
          file,
          path: `[${i}]${issue.path.length ? '.' + issue.path.join('.') : ''}`,
          message: issue.message,
        });
      }
    } else {
      out.push(result.data);
    }
  });
  return out;
}

function main(): void {
  console.log('Validating curated seed data…');

  const curated = readJsonArray('ingredients.json', IngredientSeed);
  const generated = readJsonArray('ingredients.generated.json', IngredientSeed, true);
  const merged = [...curated, ...generated];

  // Cross-file dupes within the *same* file are a bug. Cross-file dupes
  // between curated and generated are expected (the seed layer dedupes —
  // curated wins) so don't flag those. Dedup key: slug if present, else
  // lowercased EN name — matches the seeder's identity rule.
  const dupCheck = (rows: IngredientSeed[], file: string): void => {
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const key = row.slug ?? en(row.name).toLowerCase();
      if (seen.has(key)) {
        failures.push({ file, path: `[${i}]`, message: `duplicate identity "${key}"` });
      }
      seen.add(key);
    });
  };
  dupCheck(curated, 'ingredients.json');
  dupCheck(generated, 'ingredients.generated.json');

  const recipes = readJsonArray('recipes.json', RecipeSeed);
  const subs = readJsonArray('substitutions.json', SubstitutionSeed);

  // Referential integrity: recipe ingredient lines and substitutions can
  // only reference ingredients we actually have. Match by slug first,
  // fall back to lowercased EN name — same lookup rule as the seeder.
  const ingredientSlugs = new Set(merged.map((i) => i.slug).filter((s): s is string => !!s));
  const ingredientNamesLc = new Set(merged.map((i) => en(i.name).toLowerCase()));
  const ingredientExists = (ref: string): boolean =>
    ingredientSlugs.has(ref) || ingredientNamesLc.has(ref.toLowerCase());

  recipes.forEach((recipe, i) => {
    recipe.ingredients.forEach((line, j) => {
      const ref = line.slug ?? line.name!;
      if (!ingredientExists(ref)) {
        failures.push({
          file: 'recipes.json',
          path: `[${i}].ingredients[${j}]`,
          message: `unknown ingredient "${ref}" (not in ingredients.json or .generated.json)`,
        });
      }
    });
  });
  subs.forEach((sub, i) => {
    if (!ingredientExists(sub.from)) {
      failures.push({
        file: 'substitutions.json',
        path: `[${i}].from`,
        message: `unknown ingredient "${sub.from}"`,
      });
    }
    if (!ingredientExists(sub.to)) {
      failures.push({
        file: 'substitutions.json',
        path: `[${i}].to`,
        message: `unknown ingredient "${sub.to}"`,
      });
    }
  });

  console.log(
    `  ingredients.json:           ${curated.length}\n` +
      `  ingredients.generated.json: ${generated.length}\n` +
      `  recipes.json:               ${recipes.length}\n` +
      `  substitutions.json:         ${subs.length}`,
  );

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} validation issue(s):`);
    for (const f of failures) console.error(`  ${f.file} ${f.path}: ${f.message}`);
    process.exit(1);
  }
  console.log('\n✓ All seed data valid.');
}

main();
