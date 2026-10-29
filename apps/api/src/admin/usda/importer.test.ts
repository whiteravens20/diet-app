// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ImportFailure,
  importedFoods,
  pageFetcher,
  runImport,
  settingsFromEnvironment,
  type SourceFood,
} from './importer.js';

/** Real records of the source, cut down to what the importer reads. */
const foods = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/fdc-foods.json'), 'utf8'),
) as SourceFood[];
const onePage = (list: SourceFood[]) => () =>
  Promise.resolve({ totalHits: list.length, totalPages: 1, currentPage: 1, foods: list });

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
  const result = await runImport({
    apiKey: 'a-key',
    dataTypes: 'Foundation',
    outDir,
    fetchPage: onePage(list),
  });
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
    expect(row('Buttermilk, low fat')).toMatchObject({
      allergens: ['dairy'],
      dietCompatibility: ['balanced', 'vegetarian', 'low_carb'],
    });
    expect(row('Lard')!.dietCompatibility).toEqual(['balanced', 'low_carb', 'keto']);
    expect(row('Chicken, breast, boneless, skinless, raw')!.dietCompatibility).toEqual([
      'balanced',
      'low_carb',
      'high_protein',
    ]);
  });

  it('leaves out a food that lacks a macronutrient, and says which and why', async () => {
    const { result, row } = await imported();

    expect(row('Beans, Dry, Black (0% moisture)')).toBeUndefined();
    expect(row('Watermelon, seedless, flesh only, raw')).toBeUndefined();
    expect(result.refusals).toContainEqual({
      name: 'Beans, Dry, Black (0% moisture)',
      reason: 'no value for carbohydrate',
    });
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

  it('writes the same file for the same input, and leaves nothing else behind but its record', async () => {
    const first = await imported();
    const second = await imported([...foods].reverse());

    expect(readFileSync(second.result.outFile, 'utf8')).toBe(
      readFileSync(first.result.outFile, 'utf8'),
    );
    expect(readdirSync(first.outDir).sort()).toEqual([
      'ingredients.generated.json',
      'ingredients.generated.record.json',
    ]);
  });

  it('records that this version of the importer wrote the foods, and when', async () => {
    const before = Date.now();
    const { outDir } = await imported();

    const file = importedFoods(outDir);
    expect(file?.current).toBe(true);
    expect(Date.parse(file!.writtenAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("takes foods without a record for an older importer's, written when the file was", async () => {
    const { outDir, result } = await imported();
    unlinkSync(join(outDir, 'ingredients.generated.record.json'));
    const june = new Date('2026-06-12T08:00:00Z');
    utimesSync(result.outFile, june, june);

    expect(importedFoods(outDir)).toEqual({ writtenAt: june.toISOString(), current: false });

    writeFileSync(join(outDir, 'ingredients.generated.record.json'), '{"importer":0}');
    expect(importedFoods(outDir)?.current).toBe(false);
  });

  it('has nothing to say where no foods were imported', () => {
    expect(importedFoods(mkdtempSync(join(tmpdir(), 'usda-import-')))).toBeNull();
  });

  // Root may write anywhere.
  it.skipIf(process.getuid?.() === 0)(
    'asks the source for nothing when it could not write the answer down, and says where',
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'usda-import-'));
      chmodSync(outDir, 0o555);
      let asked = 0;
      const fetchPage = () => {
        asked += 1;
        return onePage(foods)();
      };

      const run = runImport({ apiKey: 'a-key', dataTypes: 'Foundation', outDir, fetchPage });

      await expect(run).rejects.toMatchObject({
        reason: 'not_writable',
        message: expect.stringContaining(outDir),
      });
      await expect(run).rejects.toBeInstanceOf(ImportFailure);
      expect(asked).toBe(0);
    },
  );

  it('lists no more than a hundred refusals, and counts them all', async () => {
    const incomplete = Array.from({ length: 150 }, (_, i) => ({
      ...foods.find((f) => f.description === 'Blackberries, raw')!,
      fdcId: i,
      description: `Berry ${i}`,
    }));
    const { result } = await imported(incomplete);

    expect(result.refused).toBe(150);
    expect(result.refusals).toHaveLength(100);
  });
});

describe('asking the source for a page', () => {
  const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });
  const page = { totalHits: 0, totalPages: 1, currentPage: 1, foods: [] };

  function fetcher(answers: Response[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const waits: number[] = [];
    const fetchPage = pageFetcher({
      apiKey: 'a-secret-key',
      dataTypes: 'Foundation,SR Legacy',
      fetch: (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(answers.shift() ?? answer(500));
      },
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    return { fetchPage, calls, waits };
  }

  it('sends the key in a header, not in the address, and gives the request a time limit', async () => {
    const { fetchPage, calls } = fetcher([answer(200, page)]);

    await fetchPage(3);

    expect(calls[0]!.url).not.toContain('a-secret-key');
    expect(calls[0]!.url).toContain('pageNumber=3');
    expect(calls[0]!.url).toContain('dataType=Foundation%2CSR%20Legacy');
    expect(new Headers(calls[0]!.init.headers).get('x-api-key')).toBe('a-secret-key');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('tries again when the source is busy or fails, waiting longer each time', async () => {
    const { fetchPage, calls, waits } = fetcher([answer(429), answer(503), answer(200, page)]);

    await expect(fetchPage(1)).resolves.toEqual(page);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([2000, 4000]);
  });

  it('waits as long as the source asks, when that is no more than a minute', async () => {
    const { fetchPage, waits } = fetcher([
      answer(429, {}, { 'retry-after': '7' }),
      answer(429, {}, { 'retry-after': '60' }),
      answer(200, page),
    ]);

    await fetchPage(1);

    expect(waits).toEqual([7000, 60_000]);
  });

  it('gives up at once when the source asks for longer: an allowance that is used up, and for how long', async () => {
    // What the source answers once the demonstration key has had its requests for the hour.
    const { fetchPage, calls, waits } = fetcher([
      answer(429, {}, { 'retry-after': '649' }),
      answer(200, page),
    ]);

    const run = fetchPage(1);

    await expect(run).rejects.toMatchObject({
      reason: 'over_limit',
      retryAfterSeconds: 649,
      message: 'FDC API 429 on page 1',
    });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('gives up after four tries, and at once on an answer that trying again cannot change', async () => {
    const busy = fetcher([answer(500), answer(500), answer(500), answer(500), answer(200, page)]);
    await expect(busy.fetchPage(2)).rejects.toMatchObject({
      reason: 'unavailable',
      message: 'FDC API 500 on page 2',
    });
    expect(busy.calls).toHaveLength(4);

    const refused = fetcher([answer(403), answer(200, page)]);
    await expect(refused.fetchPage(1)).rejects.toMatchObject({
      reason: 'key_refused',
      message: 'FDC API 403 on page 1',
    });
    expect(refused.calls).toHaveLength(1);

    const wrong = fetcher([answer(400), answer(200, page)]);
    await expect(wrong.fetchPage(1)).rejects.toMatchObject({
      reason: 'failed',
      message: 'FDC API 400 on page 1',
    });
    expect(wrong.calls).toHaveLength(1);
  });

  it('says the allowance is used up when the source is still busy after four tries', async () => {
    const { fetchPage, calls } = fetcher([answer(429), answer(429), answer(429), answer(429)]);

    await expect(fetchPage(1)).rejects.toMatchObject({
      reason: 'over_limit',
      message: 'FDC API 429 on page 1',
    });
    expect(calls).toHaveLength(4);
  });

  it('says the source is unavailable when no request gets an answer', async () => {
    const fetchPage = pageFetcher({
      apiKey: 'k',
      dataTypes: 'Foundation',
      fetch: () => Promise.reject(new Error('socket hang up')),
      sleep: () => Promise.resolve(),
    });

    await expect(fetchPage(1)).rejects.toMatchObject({
      reason: 'unavailable',
      message: 'FDC API did not answer on page 1: socket hang up',
    });
  });

  it('tries again when the request itself fails', async () => {
    const calls: number[] = [];
    const fetchPage = pageFetcher({
      apiKey: 'k',
      dataTypes: 'Foundation',
      fetch: () => {
        calls.push(1);
        return calls.length < 3
          ? Promise.reject(new Error('socket hang up'))
          : Promise.resolve(answer(200, page));
      },
      sleep: () => Promise.resolve(),
    });

    await expect(fetchPage(1)).resolves.toEqual(page);
    expect(calls).toHaveLength(3);
  });
});

describe('the settings of a run from the command line', () => {
  it('are the demonstration key and the foundation foods when nothing is set', () => {
    expect(settingsFromEnvironment({})).toEqual({ apiKey: 'DEMO_KEY', dataTypes: 'Foundation' });
  });

  it('take a variable that is set to nothing as not set', () => {
    // How a container gets a line of the env file that has no value.
    expect(settingsFromEnvironment({ FDC_API_KEY: '', FDC_DATA_TYPES: '  ' })).toEqual({
      apiKey: 'DEMO_KEY',
      dataTypes: 'Foundation',
    });
  });

  it('take what is set, the data sets in the form the source expects', () => {
    expect(
      settingsFromEnvironment({ FDC_API_KEY: ' a-key ', FDC_DATA_TYPES: 'SR Legacy , Foundation' }),
    ).toEqual({
      apiKey: 'a-key',
      dataTypes: 'SR Legacy,Foundation',
    });
  });

  it('refuse a data set the source does not have, by the name of the variable', () => {
    expect(() => settingsFromEnvironment({ FDC_DATA_TYPES: 'Foundation,Branded' })).toThrow(
      /^FDC_DATA_TYPES: /,
    );
  });
});
