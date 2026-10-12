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
import { COVERAGE_FLOOR, COVERAGE_TARGET, MACRO_OUT_OF_REACH, macroReachByDiet, recipesPerDietAndMeal } from '../src/engine/coverage.js';
import { macroSplitOf } from '../src/engine/nutrition.js';
import { plannable } from './catalogue-plans.js';

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

// What a week's plan for each diet holds of protein, fat and carbohydrate,
// against what the diet aims at. Where the two are far apart no setting will
// bring a plan to its diet: the catalogue needs recipes that fit it. The weeks
// are made as a plan is, with what a serving takes of each ingredient and the
// packs that do not keep, and say how much of those packs they use.
const { recipes: planned, perishablePacks } = plannable(catalogue);
const reach = macroReachByDiet(planned, perishablePacks);
const shares = (of: { protein: number; fat: number; carbs: number }) => [of.protein, of.fat, of.carbs].map((share) => String(Math.round(share * 100)).padStart(3)).join(' /');
console.log(`\n  protein / fat / carbohydrate, % of a day's energy; packs that do not keep, % used\n  ${''.padEnd(14)}${'aims at'.padStart(15)}${'plans reach'.padStart(17)}${'packs'.padStart(8)}`);
for (const diet of diets) {
  const reached = reach[diet];
  const far = reached && reached.distance > MACRO_OUT_OF_REACH ? `   ${Math.round(reached.distance * 100)} points off` : '';
  const packsUsed = reached?.packsUsed != null ? `${Math.round(reached.packsUsed * 100)} %` : '';
  console.log(`  ${diet.padEnd(14)}${shares(macroSplitOf(diet)).padStart(15)}${(reached ? shares(reached) : 'no plan').padStart(17)}${packsUsed.padStart(8)}${far}`);
}
const outOfReach = diets.filter((diet) => (reach[diet]?.distance ?? 0) > MACRO_OUT_OF_REACH);
if (outOfReach.length > 0) {
  console.warn(`\n! ${outOfReach.length} diet(s) are more than ${MACRO_OUT_OF_REACH * 100} points of energy from what they aim at: ${outOfReach.join(', ')}. They need recipes nearer their split.`);
}

console.log('\n✓ Curated data is valid.');
