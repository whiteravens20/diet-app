/**
 * Bulk USDA FoodData Central importer.
 *
 * Paginates FDC `/foods/search` (the only endpoint that returns `foodCategory`
 * alongside nutrients) to pull every food in the configured data types
 * (public-domain, redistributable), filters to cookable whole-food categories,
 * heuristically tags allergens / diet compatibility / canonical unit, and writes
 * `data/ingredients.generated.json`. The hand-curated `data/ingredients.json`
 * baseline always wins on a name clash — see `loadIngredients` in seed.ts.
 *
 * Usage:
 *   FDC_API_KEY=<key> FDC_DATA_TYPES='Foundation,SR Legacy' npm run import:usda
 *                                              # api.data.gov/signup; 1000 req/hr
 *   npm run import:usda                        # DEMO_KEY + Foundation only
 *                                              # (~340 foods, fits in 30 req/hr)
 *
 * Determinism: same `FDC_DATA_TYPES` + same upstream dataset → byte-identical
 * `ingredients.generated.json` (output is sorted by name).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API_KEY = process.env.FDC_API_KEY ?? 'DEMO_KEY';
// Default to Foundation only so DEMO_KEY (30 req/hr) is enough for a smoke
// import. Override with FDC_DATA_TYPES='Foundation,SR Legacy' once a real key
// is in the env — the full corpus is ~8k foods across ~41 pages.
const DATA_TYPES = process.env.FDC_DATA_TYPES ?? 'Foundation';
const BASE = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const PAGE_SIZE = 200;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');

type Category =
  | 'vegetables'
  | 'fruits'
  | 'dairy'
  | 'meat'
  | 'fish'
  | 'grains'
  | 'legumes'
  | 'nuts_seeds'
  | 'fats_oils'
  | 'spices'
  | 'pantry'
  | 'beverages';

// FDC `foodCategory.description` → our ProductCategory enum.
// `null` = listed but deliberately excluded from the import (too composed /
// culture-specific for the planner to do anything useful with).
const CATEGORY_MAP: Record<string, Category | null> = {
  'Vegetables and Vegetable Products': 'vegetables',
  'Fruits and Fruit Juices': 'fruits',
  'Dairy and Egg Products': 'dairy',
  'Beef Products': 'meat',
  'Pork Products': 'meat',
  'Poultry Products': 'meat',
  'Lamb, Veal, and Game Products': 'meat',
  'Sausages and Luncheon Meats': 'meat',
  'Finfish and Shellfish Products': 'fish',
  'Cereal Grains and Pasta': 'grains',
  'Baked Products': 'grains',
  'Breakfast Cereals': 'grains',
  'Legumes and Legume Products': 'legumes',
  'Nut and Seed Products': 'nuts_seeds',
  'Fats and Oils': 'fats_oils',
  'Spices and Herbs': 'spices',
  Beverages: 'beverages',
  'Soups, Sauces, and Gravies': 'pantry',
  Sweets: 'pantry',
  Snacks: 'pantry',
  'Baby Foods': null,
  'Fast Foods': null,
  'Restaurant Foods': null,
  'Meals, Entrees, and Side Dishes': null,
  'American Indian/Alaska Native Foods': null,
};

// Conservative regex rules — only flag obvious matches; misses are safer
// than false-positive allergen tags on a user's planner.
const ALLERGEN_RULES: { allergen: string; re: RegExp }[] = [
  {
    allergen: 'gluten',
    re: /\b(wheat|barley|rye|bulgur|spelt|farro|kamut|semolina|bread|pasta|noodle|couscous|cracker)\b/i,
  },
  { allergen: 'dairy', re: /\b(milk|cheese|yogurt|butter|cream|whey|casein|kefir|ghee)\b/i },
  { allergen: 'eggs', re: /\begg\b/i },
  {
    allergen: 'nuts',
    re: /\b(almond|cashew|hazelnut|pecan|pistachio|walnut|brazil nut|macadamia|pine nut|chestnut)\b/i,
  },
  { allergen: 'peanuts', re: /\bpeanut/i },
  { allergen: 'soy', re: /\b(soy|tofu|edamame|tempeh|miso)\b/i },
  {
    allergen: 'fish',
    re: /\b(salmon|tuna|cod|haddock|trout|halibut|sardine|mackerel|herring|anchovy|tilapia|catfish)\b/i,
  },
  {
    allergen: 'shellfish',
    re: /\b(shrimp|prawn|crab|lobster|clam|mussel|oyster|scallop|squid|octopus)\b/i,
  },
  { allergen: 'sesame', re: /\b(sesame|tahini)\b/i },
];

function detectAllergens(name: string, category: Category): string[] {
  const a = new Set<string>();
  for (const { allergen, re } of ALLERGEN_RULES) if (re.test(name)) a.add(allergen);
  if (category === 'fish') a.add('fish');
  return [...a];
}

function dietCompatibility(
  category: Category,
  allergens: string[],
  macros: { protein: number; fat: number; carbs: number },
): string[] {
  const tags = new Set<string>(['balanced']);
  const animal = category === 'meat' || category === 'fish';
  const dairyOrEgg = allergens.includes('dairy') || allergens.includes('eggs');

  if (!animal && !dairyOrEgg) {
    tags.add('vegetarian');
    tags.add('vegan');
  } else if (!animal) {
    tags.add('vegetarian');
  }
  if (macros.carbs < 10) tags.add('low_carb');
  if (macros.carbs < 5 && macros.fat > 15) tags.add('keto');
  if (macros.protein >= 15) tags.add('high_protein');
  if (
    category === 'fish' ||
    category === 'vegetables' ||
    category === 'fruits' ||
    category === 'legumes' ||
    category === 'nuts_seeds' ||
    category === 'grains'
  ) {
    tags.add('mediterranean');
  }
  return [...tags];
}

interface FdcNutrient {
  // `/foods/search` shape:
  nutrientNumber?: string;
  value?: number;
  // `/foods/list` / details shape (kept for forward-compat):
  number?: string;
  amount?: number;
  nutrient?: { number?: string };
}
interface FdcFood {
  fdcId: number;
  description: string;
  dataType?: string;
  foodCategory?: string;
  foodNutrients: FdcNutrient[];
}
interface FdcSearchResponse {
  totalHits: number;
  totalPages: number;
  currentPage: number;
  foods: FdcFood[];
}

// FDC nutrient numbers (USDA standard codes):
//   208 = Energy (kcal), 203 = Protein, 204 = Total lipid (fat), 205 = Carbohydrate.
// Carbohydrate is "by difference" (100 - water - protein - fat - ash - alcohol)
// and can come back marginally negative on high-fat / high-water foods due to
// measurement rounding — clamp to 0.
function nutrient(food: FdcFood, code: string): number {
  const n = food.foodNutrients.find(
    (x) => x.nutrientNumber === code || x.number === code || x.nutrient?.number === code,
  );
  const raw = n?.value ?? n?.amount;
  if (raw == null) return 0;
  return Math.max(0, Math.round(raw * 10) / 10);
}

async function fetchPage(pageNumber: number): Promise<FdcSearchResponse> {
  const url =
    `${BASE}?api_key=${API_KEY}` +
    `&dataType=${encodeURIComponent(DATA_TYPES)}` +
    `&pageSize=${PAGE_SIZE}&pageNumber=${pageNumber}` +
    `&query=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FDC API ${res.status} on page ${pageNumber}`);
  return res.json() as Promise<FdcSearchResponse>;
}

async function main(): Promise<void> {
  if (API_KEY === 'DEMO_KEY') {
    console.warn('⚠ Using DEMO_KEY (30 req/hr). Set FDC_API_KEY for a real key.');
  }
  console.log(`Bulk-importing ${DATA_TYPES} from USDA FDC at ${PAGE_SIZE}/page…`);

  const seen = new Set<string>();
  const ingredients: unknown[] = [];
  let kept = 0;
  let skipped = 0;
  let excluded = 0;

  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const resp = await fetchPage(page);
    totalPages = resp.totalPages;
    const foods = resp.foods ?? [];
    if (foods.length === 0) break;
    if (page === 1) {
      console.log(`  ${resp.totalHits} total hits across ${totalPages} page(s)`);
    }

    for (const food of foods) {
      const fdcCategory = food.foodCategory ?? '';
      if (!(fdcCategory in CATEGORY_MAP) || CATEGORY_MAP[fdcCategory] === null) {
        excluded++;
        continue;
      }
      const category = CATEGORY_MAP[fdcCategory] as Category;

      const name = food.description.trim();
      const key = name.toLowerCase();
      if (seen.has(key)) {
        skipped++;
        continue;
      }

      const proteinPer100 = nutrient(food, '203');
      const fatPer100 = nutrient(food, '204');
      const carbsPer100 = nutrient(food, '205');
      // Most older entries carry Energy (208) in kcal; many newer Foundation
      // entries omit it and only ship macros. Atwater general factors
      // (4·protein + 9·fat + 4·carbs) reproduce USDA's own "Calculated"
      // Energy values to within rounding, so derive on miss.
      let caloriesPer100 = nutrient(food, '208');
      if (caloriesPer100 === 0) {
        caloriesPer100 = Math.round((proteinPer100 * 4 + fatPer100 * 9 + carbsPer100 * 4) * 10) / 10;
      }
      // Drop entries with no usable nutrition (no kcal and no macros) — sparse
      // data that would confuse the planner. Real zero-kcal items (water,
      // herbs) re-enter via the curated baseline.
      if (caloriesPer100 === 0) {
        skipped++;
        continue;
      }

      const allergens = detectAllergens(name, category);
      const diet = dietCompatibility(category, allergens, {
        protein: proteinPer100,
        fat: fatPer100,
        carbs: carbsPer100,
      });

      ingredients.push({
        name,
        category,
        // FDC reports nutrition per 100 g of edible mass for every food (incl.
        // liquids), so the canonical unit is always grams here. Volumetric
        // ingredients (oils, milks) live in the hand-curated baseline, where
        // we can pair them with a sensible density.
        canonicalUnit: 'g',
        caloriesPer100,
        proteinPer100,
        fatPer100,
        carbsPer100,
        allergens,
        dietCompatibility: diet,
        tags: ['usda-imported', `fdc:${food.fdcId}`],
      });
      seen.add(key);
      kept++;
    }
    console.log(
      `  page ${page}/${totalPages}: fetched ${foods.length} · totals → kept ${kept}, skipped ${skipped}, excluded ${excluded}`,
    );
    if (page < totalPages) await new Promise((r) => setTimeout(r, 250));
  }

  // Sort by name for byte-stable output across runs.
  ingredients.sort((a, b) =>
    (a as { name: string }).name.localeCompare((b as { name: string }).name),
  );

  const outFile = join(outDir, 'ingredients.generated.json');
  writeFileSync(outFile, `${JSON.stringify(ingredients, null, 2)}\n`);
  console.log(`\nWrote ${kept} ingredients → ${outFile}`);
  console.log(`  ${excluded} excluded by category, ${skipped} skipped (dup / zero-kcal).`);
  console.log('Run `npm run data:lint` to validate, then `npm run db:seed` to load.');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
