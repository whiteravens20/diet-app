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
import { DietType, MealType } from '@diet-app/shared';
import { readCatalogue } from '../src/admin/seed/catalogue.js';
import { COVERAGE_FLOOR, COVERAGE_TARGET, recipesPerDietAndMeal } from '../src/engine/coverage.js';

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
// How many recipes each diet can draw on for each meal. The diets are worked
// out from the ingredients, so this is what a plan really has to choose from.
const slots = MealType.options;
const coverage = recipesPerDietAndMeal(catalogue.recipes.map((r) => ({ dietTags: r.dietTags, mealTypes: r.seed.mealTypes })));
const diets = DietType.options.filter((diet) => diet !== 'custom');
console.log(`\n  recipes per diet and meal\n  ${''.padEnd(14)}${slots.map((slot) => slot.padStart(17)).join('')}`);
for (const diet of diets) {
  console.log(`  ${diet.padEnd(14)}${slots.map((slot) => String(coverage[diet][slot]).padStart(17)).join('')}`);
}

// A cell under the floor is a diet no plan can be made for, or one that
// serves the same dish every day. The floor rises as recipes are added.
const thin = diets.flatMap((diet) => slots.filter((slot) => coverage[diet][slot] < COVERAGE_FLOOR).map((slot) => `${diet} ${slot}: ${coverage[diet][slot]}`));
if (thin.length > 0) {
  console.error(`\n✗ ${thin.length} diet and meal pair(s) have fewer than ${COVERAGE_FLOOR} recipe(s):`);
  for (const cell of thin) console.error(`  ${cell}`);
  process.exit(1);
}
const short = diets.reduce((sum, diet) => sum + slots.filter((slot) => coverage[diet][slot] < COVERAGE_TARGET).length, 0);
console.log(`\n  every pair has at least ${COVERAGE_FLOOR}; ${short} of ${diets.length * slots.length} are still under the ${COVERAGE_TARGET} a release needs`);

console.log('\n✓ Curated data is valid.');
