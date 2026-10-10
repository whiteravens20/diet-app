// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runImport, type SourceFood } from './importer.js';

/** Real records of the source, cut down to what the importer reads. */
const foods = JSON.parse(readFileSync(join(__dirname, 'fixtures/fdc-foods.json'), 'utf8')) as SourceFood[];
const onePage = (list: SourceFood[]) => () => Promise.resolve({ totalHits: list.length, totalPages: 1, currentPage: 1, foods: list });

interface Row {
  slug: string;
  name: { en: string };
  caloriesPer100: number;
  carbsPer100: number;
  allergens: string[];
  dietCompatibility: string[];
  tags: string[];
}

async function imported(list: SourceFood[] = foods) {
  const outDir = mkdtempSync(join(tmpdir(), 'usda-import-'));
  const result = await runImport({ apiKey: 'a-key', dataTypes: 'Foundation', outDir, fetchPage: onePage(list) });
  const rows = JSON.parse(readFileSync(result.outFile, 'utf8')) as Row[];
  return { outDir, result, rows, row: (name: string) => rows.find((r) => r.name.en === name) };
}

describe('importing foods', () => {
  it('writes what is complete, with its allergens and the diets it is known to suit', async () => {
    const { row } = await imported();

    expect(row('Nuts, almonds, whole, raw')).toMatchObject({
      slug: 'nuts-almonds-whole-raw',
      caloriesPer100: 626,
      carbsPer100: 20,
      allergens: ['nuts'],
      dietCompatibility: ['balanced', 'vegetarian', 'vegan', 'mediterranean', 'high_protein'],
      tags: ['usda-imported', 'fdc:2346393'],
    });
    expect(row('Buttermilk, low fat')).toMatchObject({ allergens: ['dairy'], dietCompatibility: ['balanced', 'vegetarian', 'low_carb'] });
    expect(row('Lard')!.dietCompatibility).toEqual(['balanced', 'low_carb', 'keto']);
    expect(row('Chicken, breast, boneless, skinless, raw')!.dietCompatibility).toEqual(['balanced', 'low_carb', 'high_protein']);
  });

  it('leaves out a food that lacks a macronutrient, and says which and why', async () => {
    const { result, row } = await imported();

    expect(row('Beans, Dry, Black (0% moisture)')).toBeUndefined();
    expect(row('Watermelon, seedless, flesh only, raw')).toBeUndefined();
    expect(result.refusals).toContainEqual({ name: 'Beans, Dry, Black (0% moisture)', reason: 'no value for carbohydrate' });
    expect(result.refused).toBe(result.refusals.length);
    expect(result.refused).toBeGreaterThan(10);
    expect(result.kept + result.refused + result.excluded + result.skipped).toBe(foods.length);
  });

  it('leaves out the categories that are dishes, not ingredients, and a food it has seen', async () => {
    const twice = [...foods, foods[0]!];
    const { result, row } = await imported(twice);

    expect(row('Restaurant, Chinese, fried rice, without meat')).toBeUndefined();
    expect(result.excluded).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('writes the same file for the same input, and leaves nothing else behind', async () => {
    const first = await imported();
    const second = await imported([...foods].reverse());

    expect(readFileSync(second.result.outFile, 'utf8')).toBe(readFileSync(first.result.outFile, 'utf8'));
    expect(readdirSync(first.outDir)).toEqual(['ingredients.generated.json']);
  });

  it('lists no more than a hundred refusals, and counts them all', async () => {
    const incomplete = Array.from({ length: 150 }, (_, i) => ({ ...foods.find((f) => f.description === 'Blackberries, raw')!, fdcId: i, description: `Berry ${i}` }));
    const { result } = await imported(incomplete);

    expect(result.refused).toBe(150);
    expect(result.refusals).toHaveLength(100);
  });
});
