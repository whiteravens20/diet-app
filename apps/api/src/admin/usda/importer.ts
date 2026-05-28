/**
 * USDA FoodData Central importer — reusable module.
 *
 * Encapsulates the FDC pagination + category filtering + heuristic tagging
 * that `scripts/import-usda.ts` originally hosted. Same algorithm; just
 * separated so the admin-panel runner and the CLI script can both call it.
 *
 * Output is byte-stable for identical inputs (results are sorted by slug).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Category =
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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
  nutrientNumber?: string;
  value?: number;
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

function nutrient(food: FdcFood, code: string): number {
  const n = food.foodNutrients.find(
    (x) => x.nutrientNumber === code || x.number === code || x.nutrient?.number === code,
  );
  const raw = n?.value ?? n?.amount;
  if (raw == null) return 0;
  return Math.max(0, Math.round(raw * 10) / 10);
}

const BASE = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const PAGE_SIZE = 200;

export interface ImportProgress {
  page: number;
  totalPages: number;
  kept: number;
  skipped: number;
  excluded: number;
}

export interface ImportResult {
  kept: number;
  skipped: number;
  excluded: number;
  totalPages: number;
  outFile: string;
  dataTypes: string;
  /** True if the supplied key was DEMO_KEY (caller may want to warn). */
  demoKey: boolean;
}

export interface ImportOptions {
  apiKey: string;
  dataTypes: string;
  /** Absolute directory containing `data/*.json`. */
  outDir: string;
  onProgress?: (p: ImportProgress) => void;
  /** Override page-fetch (test injection). */
  fetchPage?: (page: number) => Promise<FdcSearchResponse>;
}

async function defaultFetchPage(
  apiKey: string,
  dataTypes: string,
  pageNumber: number,
): Promise<FdcSearchResponse> {
  const url =
    `${BASE}?api_key=${apiKey}` +
    `&dataType=${encodeURIComponent(dataTypes)}` +
    `&pageSize=${PAGE_SIZE}&pageNumber=${pageNumber}` +
    `&query=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FDC API ${res.status} on page ${pageNumber}`);
  return (await res.json()) as FdcSearchResponse;
}

/**
 * Run the full import. Writes `ingredients.generated.json` to `outDir` and
 * returns counters. Throws on FDC errors; the runner translates that into
 * a user-visible job-status error.
 */
export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const fetchPage =
    opts.fetchPage ?? ((p: number) => defaultFetchPage(opts.apiKey, opts.dataTypes, p));

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
      let caloriesPer100 = nutrient(food, '208');
      if (caloriesPer100 === 0) {
        caloriesPer100 =
          Math.round((proteinPer100 * 4 + fatPer100 * 9 + carbsPer100 * 4) * 10) / 10;
      }
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
        slug: slugify(name),
        name: { en: name },
        category,
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
    opts.onProgress?.({ page, totalPages, kept, skipped, excluded });
    if (page < totalPages) await new Promise((r) => setTimeout(r, 250));
  }

  ingredients.sort((a, b) =>
    (a as { slug: string }).slug.localeCompare((b as { slug: string }).slug),
  );

  const outFile = join(opts.outDir, 'ingredients.generated.json');
  writeFileSync(outFile, `${JSON.stringify(ingredients, null, 2)}\n`);

  return {
    kept,
    skipped,
    excluded,
    totalPages,
    outFile,
    dataTypes: opts.dataTypes,
    demoKey: opts.apiKey === 'DEMO_KEY',
  };
}
