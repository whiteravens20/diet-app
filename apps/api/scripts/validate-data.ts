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

// Seed-input shapes (no `id` — the DB assigns those). Mirror the runtime Zod
// schemas in `@diet-app/shared` so a contract change forces a corresponding
// data-format change here.
const IngredientSeed = z.object({
  name: z.string().min(1),
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
  storageHint: z.string().optional(),
  source: z.string().optional(),
});

const RecipeSeed = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  servings: z.number().int().min(1),
  mealTypes: z.array(MealType).min(1),
  dietTags: z.array(DietType),
  prepMinutes: z.number().int().min(0),
  cookMinutes: z.number().int().min(0),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  ingredients: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.number().min(0),
        unit: Unit,
        note: z.string().optional(),
      }),
    )
    .min(1),
  steps: z.array(z.string().min(1)).min(1),
});

const SubstitutionSeed = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  note: z.string().optional(),
});

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
  // curated wins) so don't flag those.
  const dupCheck = (rows: { name: string }[], file: string): void => {
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const key = row.name.toLowerCase();
      if (seen.has(key)) {
        failures.push({ file, path: `[${i}].name`, message: `duplicate name "${row.name}"` });
      }
      seen.add(key);
    });
  };
  dupCheck(curated, 'ingredients.json');
  dupCheck(generated, 'ingredients.generated.json');

  const recipes = readJsonArray('recipes.json', RecipeSeed);
  const subs = readJsonArray('substitutions.json', SubstitutionSeed);

  // Referential integrity: recipes + substitutions can only reference
  // ingredients we actually have.
  const ingredientNames = new Set(merged.map((i) => i.name));
  recipes.forEach((recipe, i) => {
    recipe.ingredients.forEach((line, j) => {
      if (!ingredientNames.has(line.name)) {
        failures.push({
          file: 'recipes.json',
          path: `[${i}].ingredients[${j}].name`,
          message: `unknown ingredient "${line.name}" (not in ingredients.json or .generated.json)`,
        });
      }
    });
  });
  subs.forEach((sub, i) => {
    if (!ingredientNames.has(sub.from)) {
      failures.push({
        file: 'substitutions.json',
        path: `[${i}].from`,
        message: `unknown ingredient "${sub.from}"`,
      });
    }
    if (!ingredientNames.has(sub.to)) {
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
