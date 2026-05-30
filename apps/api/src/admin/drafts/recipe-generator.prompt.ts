/**
 * Recipe draft generator prompt.
 *
 * Renders a single prompt asking the AI to author N recipes — locale-keyed
 * titles / descriptions / steps + structural metadata + an ingredient list
 * picked exclusively from the in-prompt catalogue. The model authors entirely
 * from its training-data knowledge of cooking; there is no internet fetch
 * (plan D9). The ingredient catalogue is the hard whitelist.
 *
 * Few-shot files at `few-shot/recipe.<locale>.json` carry stratified exemplars
 * (~5 simple + ~5 medium + ~5 complex) sliced into the prompt. Each file is
 * locale-specific so PL exemplars anchor PL phrasing and EN exemplars anchor
 * EN structure.
 *
 * Prompt-version tag pins the rendered shape so drafts can be filtered by
 * which prompt iteration produced them — same as the ingredient namer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale, MealType, DietType, ComplexityMix, Complexity } from '@diet-app/shared';
import {
  COMPLEXITY_BANDS,
  DEFAULT_COMPLEXITY_MIX,
  normaliseMix,
  targetsForMix,
} from './recipe-generator.complexity.js';

export const RECIPE_GENERATOR_PROMPT_VERSION = 'recipe-generator.v1';

const FEW_SHOT_DIR = join(__dirname, 'few-shot');

const LOCALE_LABEL: Record<string, string> = {
  pl: 'Polish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  en: 'English',
};

/** Catalogue row sliced into the prompt. The model sees only what is needed to
 *  pick correctly — slug + display name + macros per 100 + diet flags. */
export interface CatalogueRow {
  slug: string;
  /** Display names keyed by locale; the prompt renders the EN form alongside
   *  the slug so the model can map intent to slug. */
  names: Record<string, string>;
  category: string;
  canonicalUnit: 'g' | 'ml' | 'piece';
  gramsPerPiece: number | null;
  density: number | null;
  caloriesPer100: number;
  proteinPer100: number;
  fatPer100: number;
  carbsPer100: number;
  allergens: string[];
  dietCompatibility: string[];
}

export interface RecipeGeneratorPromptInput {
  targetLocales: Locale[];
  count: number;
  complexityMix?: ComplexityMix;
  dietTags?: DietType[];
  mealTypes?: MealType[];
  cuisine?: string;
  kcalRange?: { min: number; max: number };
  avoidSlugs?: string[];
  preferSlugs?: string[];
  catalogue: CatalogueRow[];
  /** Existing recipes (live + pending drafts) the model should not duplicate.
   *  Rendered as a slug + EN title + ingredient slug set list. The validator
   *  enforces the rule via Jaccard similarity > 0.75 → reject. */
  existingRecipes?: ExistingRecipeSummary[];
}

/** Compact view of a recipe already in the instance, used for the prompt's
 *  "Avoid duplicating" section and the validator's Jaccard check. */
export interface ExistingRecipeSummary {
  slug: string;
  titleEn: string;
  ingredientSlugs: string[];
}

/** Cap so the prompt doesn't grow unbounded once the library is large. The
 *  selection prefers the most recently created rows (the runner sorts before
 *  trimming), so the model sees what's freshly drafted alongside the canonical
 *  baseline. */
export const MAX_EXISTING_RECIPES_IN_PROMPT = 60;

interface FewShotRecipe {
  complexity: Complexity;
  title: Record<string, string>;
  description: Record<string, string>;
  steps: Record<string, string[]>;
  servings: number;
  mealTypes: string[];
  dietTags: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  ingredients: { slug: string; quantity: number; unit: 'g' | 'ml' | 'piece'; note?: string }[];
}

function loadFewShot(locale: string): FewShotRecipe[] {
  const path = join(FEW_SHOT_DIR, `recipe.${locale}.json`);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FewShotRecipe[];
  } catch {
    return [];
  }
}

/** Pull a stratified slice — up to 2 of each band — from the few-shot pool.
 *  Keeps the prompt under control while showing the model what every band
 *  looks like in the target locale. */
function stratify(pool: FewShotRecipe[]): FewShotRecipe[] {
  const per: Record<Complexity, FewShotRecipe[]> = { simple: [], medium: [], complex: [] };
  for (const r of pool) per[r.complexity].push(r);
  const out: FewShotRecipe[] = [];
  for (const band of ['simple', 'medium', 'complex'] as const) {
    out.push(...per[band].slice(0, 2));
  }
  return out;
}

function renderFewShotForLocale(locale: string): string {
  const stratified = stratify(loadFewShot(locale));
  if (stratified.length === 0) return '';
  const label = LOCALE_LABEL[locale] ?? locale;
  const blocks = stratified.map((r) => JSON.stringify(r, null, 2)).join('\n\n');
  return `Exemplar recipes — ${label} (${locale}) — author your output in this exact shape:\n${blocks}\n\n`;
}

function renderCatalogue(catalogue: CatalogueRow[]): string {
  // Single TSV-ish block to minimise token usage. Header row labels the columns
  // explicitly so the model can read it once and use slugs verbatim afterwards.
  const header =
    'slug\tname_en\tcategory\tunit\tkcal/100\tP/100\tF/100\tC/100\tallergens\tdiets';
  const rows = catalogue.map((row) => {
    const enName = row.names.en ?? row.slug;
    const allergens = row.allergens.length > 0 ? row.allergens.join(',') : '-';
    const diets = row.dietCompatibility.length > 0 ? row.dietCompatibility.join(',') : '-';
    return [
      row.slug,
      enName,
      row.category,
      row.canonicalUnit,
      row.caloriesPer100,
      row.proteinPer100,
      row.fatPer100,
      row.carbsPer100,
      allergens,
      diets,
    ].join('\t');
  });
  return [header, ...rows].join('\n');
}

function renderExistingRecipes(existing: ExistingRecipeSummary[] | undefined): string {
  if (!existing || existing.length === 0) return '';
  const trimmed = existing.slice(0, MAX_EXISTING_RECIPES_IN_PROMPT);
  const lines = trimmed.map(
    (r) => `- ${r.slug} — "${r.titleEn}" — ingredients: ${r.ingredientSlugs.join(', ')}`,
  );
  const suffix =
    existing.length > trimmed.length
      ? `\n(+ ${existing.length - trimmed.length} more not shown)`
      : '';
  return `Existing recipes already in the library — DO NOT duplicate them.
You may share individual ingredients (yogurt + apples vs yogurt + bananas is
fine), but a recipe whose entire ingredient set substantially overlaps an
existing one (≥ 75 % Jaccard similarity) will be REJECTED. Pick distinct
flavour profiles, swap a hero protein/veg, or shift cuisine.
${lines.join('\n')}${suffix}

`;
}

function renderComplexityBands(): string {
  return COMPLEXITY_BANDS.map(
    (b) =>
      `- ${b.name}: ${b.minIngredients}-${b.maxIngredients} ingredients, ≤ ${b.maxSteps} steps, ≤ ${b.maxTotalMinutes} min total (prep + cook)`,
  ).join('\n');
}

export function buildRecipeGeneratorPrompt(input: RecipeGeneratorPromptInput): string {
  const targetLocales = input.targetLocales.includes('en' as Locale)
    ? input.targetLocales
    : (['en', ...input.targetLocales] as Locale[]);
  const localeList = targetLocales
    .map((l) => `${LOCALE_LABEL[l] ?? l} (${l})`)
    .join(', ');
  const mix = normaliseMix(input.complexityMix ?? DEFAULT_COMPLEXITY_MIX);
  const targetCounts = targetsForMix(input.count, mix);
  const fewShot = targetLocales.map((l) => renderFewShotForLocale(l)).join('');
  const existingBlock = renderExistingRecipes(input.existingRecipes);

  const constraints: string[] = [];
  if (input.dietTags && input.dietTags.length > 0) {
    constraints.push(
      `- Diet tags every recipe MUST satisfy: ${input.dietTags.join(', ')}. Every ingredient picked must have at least one matching dietCompatibility value.`,
    );
  }
  if (input.mealTypes && input.mealTypes.length > 0) {
    constraints.push(`- Meal types to draw from: ${input.mealTypes.join(', ')}.`);
  }
  if (input.cuisine) {
    constraints.push(`- Cuisine direction: ${input.cuisine}.`);
  }
  if (input.kcalRange) {
    constraints.push(
      `- Per-serving calorie target: ${input.kcalRange.min}–${input.kcalRange.max} kcal. The deterministic engine recomputes this from your ingredient list, so pick quantities that land in range.`,
    );
  }
  if (input.preferSlugs && input.preferSlugs.length > 0) {
    constraints.push(
      `- Lean on these slugs where they fit naturally: ${input.preferSlugs.join(', ')}. Do not force them where they don't.`,
    );
  }
  if (input.avoidSlugs && input.avoidSlugs.length > 0) {
    constraints.push(`- NEVER use these slugs: ${input.avoidSlugs.join(', ')}.`);
  }
  const constraintsBlock =
    constraints.length > 0 ? `\nAdditional constraints:\n${constraints.join('\n')}\n` : '';

  const localeKeyHints = targetLocales
    .map((l) => `      "${l}": "..."`)
    .join(',\n');
  const localeStepsHints = targetLocales
    .map((l) => `      "${l}": ["step 1", "step 2"]`)
    .join(',\n');

  return `You are a recipe author for a self-hosted diet and meal-planning
application. You will draft ${input.count} ORIGINAL home-cook recipes from your
own training knowledge of cooking. You MUST pick every ingredient from the
catalogue at the end of this prompt — you may NOT invent or rename ingredients.

╔════════════════════════════════════════════════════════════════════════╗
║  CRITICAL HARD-LIMITS — violations REJECT the whole batch:             ║
║                                                                        ║
║  • Every recipe MUST have at least 3 ingredients.                      ║
║    (Not 2. A 2-ingredient recipe is rejected. Add olive oil, salt,     ║
║     garlic, lemon, or any other catalogue staple to reach 3.)          ║
║  • Every recipe MUST have at most 16 ingredients.                      ║
║  • Total time (prepMinutes + cookMinutes) MUST be ≤ 120 min.           ║
║  • Step count MUST be ≤ 25.                                            ║
║  • \`unit\` MUST be exactly "g", "ml", or "piece" — never tbsp / cup.  ║
║  • \`difficulty\` MUST be exactly "easy", "medium", or "hard".         ║
║  • Every ingredient slug MUST be a literal string from the catalogue.  ║
║                                                                        ║
║  The labels "simple/medium/complex" below describe BAND BOUNDARIES,    ║
║  not "smaller is simpler". Even a "simple" recipe must hit the         ║
║  3-ingredient minimum.                                                 ║
╚════════════════════════════════════════════════════════════════════════╝

Target locales: ${localeList}. Every text field MUST be filled for every
listed locale. English (en) is the canonical source — write it first, then
write the other locale(s) as natural-sounding translations a native speaker
would actually write on a recipe card.

Complexity bands (every recipe MUST fit inside ONE band — outside every band = reject):
${renderComplexityBands()}

Requested complexity mix for this batch (${input.count} total): ${targetCounts.simple} simple, ${targetCounts.medium} medium, ${targetCounts.complex} complex.
${constraintsBlock}
Hard rules — follow strictly. The validator rejects the WHOLE batch on a
single violation, so be precise:

1. Use ONLY slugs that appear in the catalogue below. Copy each slug
   character-for-character. Do NOT invent slugs (no \`lemon\`, \`salt\`,
   \`soy-sauce\` unless that exact string is in the catalogue). Do NOT
   strip suffixes, pluralise, capitalise, or substitute hyphens. If a
   common cooking ingredient isn't in the catalogue, REWRITE the recipe
   around what IS available — never reach for a slug that doesn't exist.
2. \`unit\` must be EXACTLY one of: \`"g"\`, \`"ml"\`, or \`"piece"\`. Never
   \`tbsp\`, \`tsp\`, \`cup\`, \`oz\`, \`pcs\`. Use the slug's canonical unit
   (the \`unit\` column in the catalogue). Convert to grams or millilitres
   as needed (1 tbsp olive oil ≈ 14 ml; 1 pinch salt ≈ 1 g).
3. Quantities are positive NUMBERS — no ranges, no "to taste", no
   string fractions. Decimals are fine.
4. Every recipe MUST include EVERY structural field: \`slug\`, \`titles\`,
   \`descriptions\`, \`steps\`, \`servings\`, \`mealTypes\` (non-empty array),
   \`dietTags\` (array, may be empty), \`prepMinutes\`, \`cookMinutes\`,
   \`difficulty\` (exactly \`"easy"\`, \`"medium"\`, or \`"hard"\`), and
   \`ingredients\`. Skipping \`difficulty\` is the most common rejection —
   always emit it.
5. Mix sensible, recognisable home cooking. Avoid contrived combinations
   (no "cucumber baked with coconut oil"). Cuisine inspirations are fine
   (Italian, Polish, Mediterranean, Asian-fusion, etc.) — pick coherent
   flavour profiles.
6. NEVER author nutrition, calorie, or macro values yourself. They are
   recomputed deterministically from your ingredient list by the engine.
7. Diet tag honesty: if you tag a recipe \`vegan\`, every ingredient's
   dietCompatibility column must include \`vegan\`. Same for vegetarian,
   keto, etc. The validator rejects mismatches.
8. Servings: pick the natural family-meal serving size (usually 1–4).
   Larger only when the recipe genuinely scales that way (stews, bakes).
9. Steps are imperative-form sentences. Number is implicit — do NOT
   prefix with "Step 1:" / "1." / "Krok 1:". The array order IS the
   numbering.
10. Ingredient count and step count and total time (prep + cook) must
    ALL fall inside ONE complexity band from the table above. A recipe
    with 2 ingredients, or 16+, or 21+ steps, or > 90 min is rejected.
11. Output literal characters in JSON values. Never HTML-escape.
12. Each recipe MUST have a stable \`slug\` (kebab-case, ASCII, lowercase,
    derived from the English title). Slugs are unique within the batch.

Return ONLY a JSON object of this exact shape — no prose, no fences:

{
  "recipes": [
    {
      "slug": "<kebab-case-id>",
      "titles": {
${localeKeyHints}
      },
      "descriptions": {
${localeKeyHints}
      },
      "steps": {
${localeStepsHints}
      },
      "servings": 2,
      "mealTypes": ["lunch"],
      "dietTags": ["balanced"],
      "prepMinutes": 15,
      "cookMinutes": 25,
      "difficulty": "medium",
      "ingredients": [
        { "slug": "<catalogue slug>", "quantity": 250, "unit": "g" }
      ]
    }
  ]
}

${existingBlock}${fewShot}Ingredient catalogue (slugs you MUST pick from):
${renderCatalogue(input.catalogue)}

Now write ${input.count} recipe(s).`;
}
