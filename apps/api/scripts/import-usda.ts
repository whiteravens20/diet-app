// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Bulk USDA FoodData Central importer (CLI entrypoint).
 *
 * Thin wrapper around `src/admin/usda/importer.ts` — the same code path the
 * admin panel calls. Keeps `npm run import:usda` working for hosts that
 * prefer the CLI over the admin UI.
 *
 * Usage:
 *   FDC_API_KEY=<key> npm run import:usda      # a free key from api.data.gov/signup;
 *                                              # Foundation only (~340 foods).
 *   npm run import:usda                        # the public DEMO_KEY, which allows
 *                                              # a few requests an hour: Foundation
 *                                              # at most.
 *
 * `FDC_DATA_TYPES` can include `SR Legacy` for about 7,000 more foods, but most
 * of them are brand names or cuts of one animal, and each is put before the
 * model that drafts recipes: see `data/README.md` before enabling it.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runImport, settingsFromEnvironment } from '../src/admin/usda/importer.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');

async function main(): Promise<void> {
  const { apiKey, dataTypes } = settingsFromEnvironment(process.env);
  if (apiKey === 'DEMO_KEY') {
    console.warn('⚠ Using the public DEMO_KEY, which allows only a few requests an hour. Set FDC_API_KEY for a key of your own.');
  }
  console.log(`Bulk-importing ${dataTypes} from USDA FDC at 200/page…`);

  const result = await runImport({
    apiKey,
    dataTypes,
    outDir,
    onProgress: (p) =>
      console.log(
        `  page ${p.page}/${p.totalPages}: totals → kept ${p.kept}, refused ${p.refused}, skipped ${p.skipped}, excluded ${p.excluded}`,
      ),
  });

  console.log(`\nWrote ${result.kept} ingredients → ${result.outFile}`);
  console.log(`  ${result.excluded} excluded by category, ${result.skipped} listed twice.`);
  if (result.refused > 0) {
    console.log(`  ${result.refused} left out because their record is incomplete or contradicts itself:`);
    for (const { name, reason } of result.refusals) console.log(`    ${name}: ${reason}`);
    if (result.refused > result.refusals.length) console.log(`    … and ${result.refused - result.refusals.length} more.`);
  }
  console.log('Run `npm run data:lint` to validate, then `npm run db:seed` to load.');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
