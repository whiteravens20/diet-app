/**
 * Seeds the curated product database — the source of truth for nutrition.
 *
 * Recipe per-serving nutrition is COMPUTED deterministically here from the
 * ingredient table via the engine's unit conversion, never authored by hand.
 * Re-running is idempotent (upsert by natural key).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { nutritionFor, toCanonical } from '../src/engine/units.js';
import { composeRecipes, type ComposableIngredient } from '../src/engine/recipe-templates.js';

// Load the repo-root .env for local runs; in containers the env is preset.
try {
  process.loadEnvFile('../../.env');
} catch {
  /* environment already provided */
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');

type Unit = 'g' | 'ml' | 'piece';

interface IngredientSeed {
  name: string;
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
  storageHint?: string;
}

interface RecipeSeed {
  title: string;
  description: string;
  servings: number;
  mealTypes: string[];
  dietTags: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  ingredients: { name: string; quantity: number; unit: Unit; note?: string }[];
  steps: string[];
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(dataDir, file), 'utf8')) as T;
}

/**
 * Curated ingredients, plus USDA-imported ones from `ingredients.generated.json`
 * if `import-usda.ts` has been run. Curated entries win on a name clash.
 */
function loadIngredients(): IngredientSeed[] {
  const curated = readJson<IngredientSeed[]>('ingredients.json');
  const generatedPath = join(dataDir, 'ingredients.generated.json');
  if (!existsSync(generatedPath)) return curated;

  const generated = JSON.parse(readFileSync(generatedPath, 'utf8')) as IngredientSeed[];
  const curatedNames = new Set(curated.map((i) => i.name));
  const extra = generated.filter((i) => !curatedNames.has(i.name));
  console.log(`  + ${extra.length} USDA-imported ingredients`);
  return [...curated, ...extra];
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

async function main(): Promise<void> {
  console.log('Seeding allergens…');
  for (const [code, label] of ALLERGENS) {
    await prisma.allergen.upsert({ where: { code }, create: { code, label }, update: { label } });
  }

  console.log('Seeding ingredients…');
  const ingredients = loadIngredients();
  const byName = new Map<string, { id: string; row: IngredientSeed }>();
  for (const ing of ingredients) {
    const row = await prisma.ingredient.upsert({
      where: { name: ing.name },
      create: {
        name: ing.name,
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
        storageHint: ing.storageHint ?? null,
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
      update: {
        caloriesPer100: ing.caloriesPer100,
        proteinPer100: ing.proteinPer100,
        fatPer100: ing.fatPer100,
        carbsPer100: ing.carbsPer100,
      },
    });
    byName.set(ing.name, { id: row.id, row: ing });
  }

  // Anchor recipes are hand-curated; the rest are composed deterministically
  // from templates × the curated database (the no-AI fallback library).
  const anchors = readJson<RecipeSeed[]>('recipes.json');
  const composable: ComposableIngredient[] = ingredients.map((i) => ({
    name: i.name,
    category: i.category as ComposableIngredient['category'],
    tags: i.tags,
    dietCompatibility: i.dietCompatibility as ComposableIngredient['dietCompatibility'],
  }));
  const composed = composeRecipes(composable) as RecipeSeed[];
  const recipes = [...anchors, ...composed];
  console.log(
    `Seeding recipes (nutrition computed deterministically): ` +
      `${anchors.length} anchor + ${composed.length} composed…`,
  );

  for (const recipe of recipes) {
    let calories = 0;
    let protein = 0;
    let fat = 0;
    let carbs = 0;
    const allergens = new Set<string>();

    for (const line of recipe.ingredients) {
      const ing = byName.get(line.name);
      if (!ing) throw new Error(`recipe "${recipe.title}" references unknown ingredient "${line.name}"`);
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
    const ingredientLines = recipe.ingredients.map((line) => ({
      ingredientId: byName.get(line.name)!.id,
      quantity: line.quantity,
      unit: line.unit,
      note: line.note ?? null,
    }));
    const fields = {
      description: recipe.description,
      servings: s,
      mealTypes: recipe.mealTypes,
      dietTags: recipe.dietTags,
      steps: recipe.steps,
      prepMinutes: recipe.prepMinutes,
      cookMinutes: recipe.cookMinutes,
      difficulty: recipe.difficulty,
      allergens: [...allergens],
      caloriesPerServing: Math.round(calories / s),
      proteinPerServing: Math.round(protein / s),
      fatPerServing: Math.round(fat / s),
      carbsPerServing: Math.round(carbs / s),
    };
    // Idempotent and FK-safe: refresh an existing seed recipe in place — its id
    // may be referenced by planned meals — otherwise create it.
    const existing = await prisma.recipe.findFirst({
      where: { title: recipe.title, origin: 'seed' },
    });
    if (existing) {
      await prisma.recipe.update({
        where: { id: existing.id },
        data: { ...fields, ingredients: { deleteMany: {}, create: ingredientLines } },
      });
    } else {
      await prisma.recipe.create({
        data: { title: recipe.title, origin: 'seed', ...fields, ingredients: { create: ingredientLines } },
      });
    }
  }

  console.log('Seeding substitution rules…');
  const subs = readJson<{ from: string; to: string; note?: string }[]>('substitutions.json');
  for (const sub of subs) {
    const from = byName.get(sub.from);
    const to = byName.get(sub.to);
    if (!from || !to) continue;
    await prisma.substitutionRule.upsert({
      where: { fromIngredientId_toIngredientId: { fromIngredientId: from.id, toIngredientId: to.id } },
      create: { fromIngredientId: from.id, toIngredientId: to.id, note: sub.note ?? null },
      update: { note: sub.note ?? null },
    });
  }

  console.log(
    `Seed complete: ${ingredients.length} ingredients, ${recipes.length} recipes ` +
      `(${anchors.length} anchor + ${composed.length} composed), ${subs.length} substitutions.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
