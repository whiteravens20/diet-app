/**
 * Bulk USDA FoodData Central importer (CLI entrypoint).
 *
 * Thin wrapper around `src/admin/usda/importer.ts` — the same code path the
 * admin panel calls. Keeps `npm run import:usda` working for hosts that
 * prefer the CLI over the admin UI.
 *
 * Usage:
 *   FDC_API_KEY=<key> npm run import:usda      # api.data.gov/signup; 1000 req/hr
 *                                              # Foundation only (~340 foods).
 *   npm run import:usda                        # DEMO_KEY + Foundation only
 *                                              # (fits in 30 req/hr quota).
 *
 * `FDC_DATA_TYPES` can include `SR Legacy` to pull the ~7 k legacy corpus, but
 * the result is dominated by brand SKUs and cut-specific entries that pollute
 * the template-generated recipe set — see `data/README.md` before enabling.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runImport } from '../src/admin/usda/importer.js';

const API_KEY = process.env.FDC_API_KEY ?? 'DEMO_KEY';
const DATA_TYPES = process.env.FDC_DATA_TYPES ?? 'Foundation';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');

async function main(): Promise<void> {
  if (API_KEY === 'DEMO_KEY') {
    console.warn('⚠ Using DEMO_KEY (30 req/hr). Set FDC_API_KEY for a real key.');
  }
  console.log(`Bulk-importing ${DATA_TYPES} from USDA FDC at 200/page…`);

  const result = await runImport({
    apiKey: API_KEY,
    dataTypes: DATA_TYPES,
    outDir,
    onProgress: (p) =>
      console.log(
        `  page ${p.page}/${p.totalPages}: totals → kept ${p.kept}, skipped ${p.skipped}, excluded ${p.excluded}`,
      ),
  });

  console.log(`\nWrote ${result.kept} ingredients → ${result.outFile}`);
  console.log(`  ${result.excluded} excluded by category, ${result.skipped} skipped (dup / zero-kcal).`);
  console.log('Run `npm run data:lint` to validate, then `npm run db:seed` to load.');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
