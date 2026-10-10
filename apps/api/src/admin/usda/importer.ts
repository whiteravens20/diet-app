// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * USDA FoodData Central importer, used by the admin panel's runner and by the
 * command-line script.
 *
 * It pages through the source, keeps the foods of the categories that are
 * ingredients, and writes them as catalogue rows. What a food contains and
 * which diets it suits is decided in `classify.ts`, its energy and
 * macronutrients in `nutrients.ts`. A food whose record is incomplete is left
 * out and reported: a row with a made-up zero is worse than no row.
 *
 * The output is the same file for the same input (rows are sorted by slug).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from './classify.js';
import { macrosOf, type SourceNutrient } from './nutrients.js';

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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The diets a row lists. `balanced` suits everything; the three that depend on
 * what the food is come from its classification; the three that depend on its
 * figures are read off the figures.
 */
function dietCompatibility(
  established: readonly string[],
  macros: { proteinPer100: number; fatPer100: number; carbsPer100: number },
): string[] {
  const tags = ['balanced', ...established];
  if (macros.carbsPer100 < 10) tags.push('low_carb');
  if (macros.carbsPer100 < 5 && macros.fatPer100 > 15) tags.push('keto');
  if (macros.proteinPer100 >= 15) tags.push('high_protein');
  return tags;
}

/** A food as the source's search returns it. */
export interface SourceFood {
  fdcId: number;
  description: string;
  dataType?: string;
  foodCategory?: string;
  foodNutrients: SourceNutrient[];
}
interface SourcePage {
  totalHits: number;
  totalPages: number;
  currentPage: number;
  foods: SourceFood[];
}

const BASE = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const PAGE_SIZE = 200;
/** The refusals a run lists by name; the count is always complete. */
const LISTED_REFUSALS = 100;

export interface ImportProgress {
  page: number;
  totalPages: number;
  kept: number;
  skipped: number;
  excluded: number;
  refused: number;
}

export interface ImportResult {
  kept: number;
  /** Foods the source lists twice under one description. */
  skipped: number;
  /** Foods of categories that are dishes or products, not ingredients. */
  excluded: number;
  /** Foods left out because their record is incomplete or contradicts itself. */
  refused: number;
  /** The first of them, with the reason. */
  refusals: { name: string; reason: string }[];
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
  fetchPage?: (page: number) => Promise<SourcePage>;
}

async function defaultFetchPage(
  apiKey: string,
  dataTypes: string,
  pageNumber: number,
): Promise<SourcePage> {
  const url =
    `${BASE}?api_key=${apiKey}` +
    `&dataType=${encodeURIComponent(dataTypes)}` +
    `&pageSize=${PAGE_SIZE}&pageNumber=${pageNumber}` +
    `&query=*`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FDC API ${res.status} on page ${pageNumber}`);
  return (await res.json()) as SourcePage;
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
  const ingredients: { slug: string }[] = [];
  const refusals: ImportResult['refusals'] = [];
  let kept = 0;
  let skipped = 0;
  let excluded = 0;
  let refused = 0;

  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const resp = await fetchPage(page);
    totalPages = resp.totalPages;
    const foods = resp.foods ?? [];
    if (foods.length === 0) break;

    for (const food of foods) {
      const sourceCategory = food.foodCategory ?? '';
      const category = CATEGORY_MAP[sourceCategory];
      if (!category) {
        excluded++;
        continue;
      }

      const name = food.description.trim();
      const key = name.toLowerCase();
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);

      const macros = macrosOf(food.foodNutrients);
      if ('refused' in macros) {
        refused++;
        if (refusals.length < LISTED_REFUSALS) refusals.push({ name, reason: macros.refused });
        continue;
      }
      const { allergens, diets } = classify(name, sourceCategory);

      ingredients.push({
        slug: slugify(name),
        name: { en: name },
        category,
        canonicalUnit: 'g',
        ...macros,
        allergens,
        dietCompatibility: dietCompatibility(diets, macros),
        tags: ['usda-imported', `fdc:${food.fdcId}`],
      } as { slug: string });
      kept++;
    }
    opts.onProgress?.({ page, totalPages, kept, skipped, excluded, refused });
    if (page < totalPages) await new Promise((r) => setTimeout(r, 250));
  }

  ingredients.sort((a, b) => a.slug.localeCompare(b.slug));

  const outFile = join(opts.outDir, 'ingredients.generated.json');
  writeFileSync(outFile, `${JSON.stringify(ingredients, null, 2)}\n`);

  return {
    kept,
    skipped,
    excluded,
    refused,
    refusals,
    totalPages,
    outFile,
    dataTypes: opts.dataTypes,
    demoKey: opts.apiKey === 'DEMO_KEY',
  };
}
