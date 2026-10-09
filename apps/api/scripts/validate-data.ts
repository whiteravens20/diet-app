// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Lint for the curated data in `data/`. It loads the data exactly the way the
 * seeder does (`readCatalogue`): every seed file, the shipped recipe batches
 * and the name overrides are parsed, validated and cross-referenced. What
 * passes here can be seeded; what fails is reported with its file and path, and
 * the script exits non-zero.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalogue } from '../src/admin/seed/catalogue.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');

console.log('Validating curated seed data…');
const { catalogue, problems } = readCatalogue(dataDir);

if (!catalogue) {
  console.error(`\n✗ ${problems.length} validation issue(s):`);
  for (const p of problems) console.error(`  ${p.file} ${p.path}: ${p.message}`);
  process.exit(1);
}

const shipped = catalogue.recipes.length - catalogue.anchorRecipes;
console.log(
  `  ingredients:    ${catalogue.ingredients.length}\n` +
    `  recipes:        ${catalogue.recipes.length} (${catalogue.anchorRecipes} anchor + ${shipped} shipped)\n` +
    `  substitutions:  ${catalogue.substitutions.length}\n` +
    `  name overrides: ${Object.keys(catalogue.overrides).length}`,
);
console.log('\n✓ Curated data is valid.');
