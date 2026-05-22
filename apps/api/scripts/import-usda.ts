/**
 * USDA FoodData Central importer.
 *
 * Builds the curated ingredient database from USDA FDC — public-domain,
 * redistributable nutrition data — so the app never invents nutrition facts.
 * It queries a curated list of whole foods (FDC's noisy branded data is
 * deliberately excluded) and writes `data/ingredients.generated.json`, which
 * `prisma/seed.ts` merges on top of the hand-curated `data/ingredients.json`.
 *
 * Usage:
 *   FDC_API_KEY=<key> npm run import:usda      # key: https://api.data.gov/signup
 *   npm run import:usda                        # falls back to DEMO_KEY (rate-limited)
 *
 * Determinism: one FDC food per query term, first Foundation/SR-Legacy match.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const API_KEY = process.env.FDC_API_KEY ?? 'DEMO_KEY';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');

/** Curated whole-food query list. Extend this — never import branded data. */
const QUERIES: { term: string; category: string; canonicalUnit: 'g' | 'ml' | 'piece' }[] = [
  { term: 'Chicken, breast, boneless, skinless, raw', category: 'meat', canonicalUnit: 'g' },
  { term: 'Beef, ground, 85% lean, raw', category: 'meat', canonicalUnit: 'g' },
  { term: 'Pork, loin, raw', category: 'meat', canonicalUnit: 'g' },
  { term: 'Salmon, Atlantic, raw', category: 'fish', canonicalUnit: 'g' },
  { term: 'Tuna, light, canned in water', category: 'fish', canonicalUnit: 'g' },
  { term: 'Egg, whole, raw', category: 'dairy', canonicalUnit: 'g' },
  { term: 'Milk, whole, 3.25% milkfat', category: 'dairy', canonicalUnit: 'ml' },
  { term: 'Yogurt, Greek, plain, nonfat', category: 'dairy', canonicalUnit: 'g' },
  { term: 'Rice, white, long-grain, raw', category: 'grains', canonicalUnit: 'g' },
  { term: 'Oats, rolled, dry', category: 'grains', canonicalUnit: 'g' },
  { term: 'Quinoa, uncooked', category: 'grains', canonicalUnit: 'g' },
  { term: 'Broccoli, raw', category: 'vegetables', canonicalUnit: 'g' },
  { term: 'Spinach, raw', category: 'vegetables', canonicalUnit: 'g' },
  { term: 'Potato, raw', category: 'vegetables', canonicalUnit: 'g' },
  { term: 'Lentils, raw', category: 'legumes', canonicalUnit: 'g' },
  { term: 'Chickpeas, mature seeds, raw', category: 'legumes', canonicalUnit: 'g' },
  { term: 'Almonds, raw', category: 'nuts_seeds', canonicalUnit: 'g' },
  { term: 'Olive oil', category: 'fats_oils', canonicalUnit: 'ml' },
  { term: 'Banana, raw', category: 'fruits', canonicalUnit: 'g' },
  { term: 'Apple, raw, with skin', category: 'fruits', canonicalUnit: 'g' },
];

interface FdcNutrient {
  nutrientName: string;
  value: number;
}
interface FdcFood {
  description: string;
  foodNutrients: FdcNutrient[];
}

function nutrient(food: FdcFood, match: string): number {
  const n = food.foodNutrients.find((x) => x.nutrientName.toLowerCase().includes(match));
  return n ? Math.round(n.value * 10) / 10 : 0;
}

async function searchFood(term: string): Promise<FdcFood | null> {
  const url =
    `${API}?api_key=${API_KEY}&pageSize=1&dataType=${encodeURIComponent('Foundation,SR Legacy')}` +
    `&query=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FDC API ${res.status} for "${term}"`);
  const data = (await res.json()) as { foods: FdcFood[] };
  return data.foods[0] ?? null;
}

async function main(): Promise<void> {
  console.log(`Importing ${QUERIES.length} foods from USDA FoodData Central…`);
  const ingredients = [];

  for (const q of QUERIES) {
    try {
      const food = await searchFood(q.term);
      if (!food) {
        console.warn(`  no FDC match for "${q.term}" — skipped`);
        continue;
      }
      ingredients.push({
        name: food.description,
        category: q.category,
        canonicalUnit: q.canonicalUnit,
        caloriesPer100: nutrient(food, 'energy'),
        proteinPer100: nutrient(food, 'protein'),
        fatPer100: nutrient(food, 'total lipid'),
        carbsPer100: nutrient(food, 'carbohydrate'),
        allergens: [],
        dietCompatibility: ['balanced'],
        tags: ['usda-imported'],
        source: 'USDA FoodData Central',
      });
      console.log(`  ✓ ${food.description}`);
      await new Promise((r) => setTimeout(r, 250)); // be gentle on the API
    } catch (err) {
      console.error(`  ✗ ${q.term}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const outFile = join(outDir, 'ingredients.generated.json');
  writeFileSync(outFile, `${JSON.stringify(ingredients, null, 2)}\n`);
  console.log(`Wrote ${ingredients.length} ingredients → ${outFile}`);
  console.log('Review the file, then run `npm run db:seed`.');
}

void main();
