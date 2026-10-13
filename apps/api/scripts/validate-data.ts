// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Lint for the curated data in `data/`. It loads the data exactly the way the
 * seeder does (`readCatalogue`): every seed file, the shipped recipe batches
 * and the name overrides are parsed, validated and cross-referenced. What
 * passes here can be seeded; what fails is reported with its file and path, and
 * the script exits non-zero.
 */
import { join } from 'node:path';
import { DietType, MealType } from '@diet-app/shared';
import { IMPORT_ALIASES_FILE, readImportAliases } from '../src/admin/drafts/external/import-aliases.js';
import { readCatalogue } from '../src/admin/seed/catalogue.js';
import { givenAsCooked, LEAST_ENERGY_OF_A_DRY_STAPLE } from '../src/admin/seed/dry-staples.js';
import { givenAsCookedMeat, MOST_PROTEIN_OF_RAW_MEAT } from '../src/admin/seed/raw-meat.js';
import { COVERAGE_TARGET, MACRO_OUT_OF_REACH, macroReachByDiet, recipesPerDietAndMeal } from '../src/engine/coverage.js';
import { macroSplitOf } from '../src/engine/nutrition.js';
import { plannable } from './catalogue-plans.js';

const dataDir = join(__dirname, '../../../data');

console.log('Validating curated seed data…');
const { catalogue, problems } = readCatalogue(dataDir);

if (!catalogue) {
  console.error(`\n✗ ${problems.length} validation issue(s):`);
  for (const p of problems) console.error(`  ${p.file} ${p.path}: ${p.message}`);
  process.exit(1);
}

// The other names an import knows ingredients by: each has to name an ingredient there is.
const { aliases, problems: aliasProblems } = readImportAliases(dataDir, new Set(catalogue.ingredients.map((ingredient) => ingredient.slug)));
if (aliasProblems.length > 0) {
  console.error(`\n✗ ${aliasProblems.length} issue(s) in ${IMPORT_ALIASES_FILE}:`);
  for (const problem of aliasProblems) console.error(`  ${problem}`);
  process.exit(1);
}

// A grain or a pulse that keeps in its pack is weighed and bought dry: figures of the cooked food would give its dishes a third of their energy.
const cooked = givenAsCooked(catalogue.ingredients);
if (cooked.length > 0) {
  console.error(`\n✗ ${cooked.length} dry food(s) with the figures of the cooked food (under ${LEAST_ENERGY_OF_A_DRY_STAPLE} kcal in 100 g):`);
  for (const slug of cooked) console.error(`  ${slug}: give it per 100 g as it is bought, or name it in KEEPS_BUT_IS_NOT_DRY with what it is`);
  process.exit(1);
}

// Meat and fish are weighed and bought raw: figures of the cooked food would give their dishes a third more protein and energy than they have.
const cookedMeat = givenAsCookedMeat(catalogue.ingredients);
if (cookedMeat.length > 0) {
  console.error(`\n✗ ${cookedMeat.length} meat or fish with the figures of the cooked food (over ${MOST_PROTEIN_OF_RAW_MEAT} g of protein in 100 g):`);
  for (const slug of cookedMeat) console.error(`  ${slug}: give it per 100 g as it is bought`);
  process.exit(1);
}

const shipped = catalogue.recipes.length - catalogue.anchorRecipes;
console.log(
  `  ingredients:    ${catalogue.ingredients.length}\n` +
    `  recipes:        ${catalogue.recipes.length} (${catalogue.anchorRecipes} anchor + ${shipped} shipped)\n` +
    `  substitutions:  ${catalogue.substitutions.length}\n` +
    `  name overrides: ${Object.keys(catalogue.overrides).length}\n` +
    `  imported foods left out as curated ones: ${catalogue.importedLeftOut}\n` +
    `  import aliases: ${Object.keys(aliases).length}`,
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

// A cell under what a week needs is a diet that is served the same dish day
// after day, or one no plan can be made for.
const thin = diets.flatMap((diet) => slots.filter((slot) => coverage[diet][slot] < COVERAGE_TARGET).map((slot) => `${diet} ${slot}: ${coverage[diet][slot]}`));
if (thin.length > 0) {
  console.error(`\n✗ ${thin.length} diet and meal pair(s) have fewer than the ${COVERAGE_TARGET} recipes a week needs:`);
  for (const cell of thin) console.error(`  ${cell}`);
  process.exit(1);
}
console.log(`\n  every pair has the ${COVERAGE_TARGET} recipes a week needs, or more`);

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
