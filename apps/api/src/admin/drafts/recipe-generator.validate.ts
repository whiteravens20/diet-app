// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Recipe draft post-validator.
 *
 * Walks the AI's JSON response and rejects rows we wouldn't want a human
 * reviewer to even see. Every recipe goes through the same gate so the
 * curation queue is never polluted with structurally-broken drafts. A recipe
 * is judged by itself: one that breaks a rule is refused with its reason,
 * and the others of the answer are kept.
 *
 *   - The rules every recipe has to meet, whoever wrote it (`checkRecipe`):
 *     plain text of a length, for every language of the run, sane numbers, a
 *     ceiling on what one serving holds.
 *   - Two that apply to a model's batch only: an empty step and a step that
 *     is the model talking are refused, so that the call is made again.
 *   - Slug resolution against the injected catalogue (`resolveSlug`).
 *   - Nutrition, allergens and diets worked out by the engine from the
 *     ingredients (`recipeFacts`). The draft stores those; what the AI
 *     claims about any of them is not stored.
 *   - A recipe that does not qualify for a diet the run asked for is
 *     rejected.
 *   - 5%-delta sanity: if AI volunteered nutrition values and they diverge
 *     from engine values by > 5 %, reject — the AI is probably lying
 *     about portion sizes.
 *   - Complexity auto-tag via `classifyComplexity`. Rows outside every
 *     band are rejected.
 *
 * The validator is injected with `resolveSlug` so unit tests can stub
 * the catalogue without a live DB.
 */
import { MAX_BATCH_REPLY_CHARS, readModelObject } from '../../ai/model-json.js';
import { recipeFacts } from '../../engine/recipe-facts.js';
import {
  classifyComplexity,
  type ComplexityBand,
  COMPLEXITY_BANDS,
} from './recipe-generator.complexity.js';
import { fitsDiet, type Complexity, type DietType } from '@diet-app/shared';
import { checkRecipe, type RecipeRule } from '../../recipes/recipe-rules.js';
import { slugify } from '../seed/catalogue.js';

type RecipeValidationReason =
  | RecipeRule
  | 'malformed-json'
  | 'no-recipes-key'
  | 'empty-batch'
  | 'empty-step'
  | 'unknown-slug'
  | 'duplicate-slug-in-batch'
  | 'duplicate-title-in-batch'
  | 'slug-taken'
  | 'title-taken'
  | 'meal-not-asked-for'
  | 'ingredient-count-out-of-bands'
  | 'step-count-too-high'
  | 'total-time-too-high'
  | 'no-matching-complexity-band'
  | 'diet-conflict'
  | 'unit-conversion-failed'
  | 'invented-nutrition'
  | 'llm-yap'
  | 'duplicate-of-existing';

export interface ResolvedIngredient {
  slug: string;
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

export interface RecipeDraftCandidate {
  slug: string;
  titles: Record<string, string>;
  descriptions: Record<string, string>;
  steps: Record<string, string[]>;
  servings: number;
  mealTypes: string[];
  dietTags: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: 'easy' | 'medium' | 'hard';
  complexity: Complexity;
  ingredients: { slug: string; quantity: number; unit: 'g' | 'ml' | 'piece'; note: string | null }[];
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  allergens: string[];
}

/** Why one recipe of an answer is not written. */
interface RecipeRefusal {
  reason: RecipeValidationReason;
  /** Identifies the recipe (slug or index) and field that triggered the
   *  failure. */
  key?: string;
  details?: string;
}

/**
 * An answer some of whose recipes can be written. A recipe is judged by
 * itself: one that breaks a rule is refused with its reason, and the others
 * of the answer are kept.
 */
interface RecipeValidationOk {
  ok: true;
  candidates: RecipeDraftCandidate[];
  /** The recipes of the answer that are not written, in the order they came. */
  refused: RecipeRefusal[];
}
/** An answer nothing can be written of: it could not be read, or every recipe of it was refused (the first refusal is said). */
interface RecipeValidationFail extends RecipeRefusal {
  ok: false;
}
export type RecipeValidationResult = RecipeValidationOk | RecipeValidationFail;

export interface ValidateRecipeBatchOptions {
  targetLocales: string[];
  rawOutput: string;
  /** Catalogue lookup. Returns null when the slug is unknown so the
   *  validator can reject the row. */
  resolveSlug: (slug: string) => ResolvedIngredient | null;
  /** Tolerance for the AI-volunteered nutrition delta check. */
  nutritionDeltaTolerance?: number;
  /** Existing recipes (live + pending drafts) to dedup against. Each new
   *  candidate is rejected when Jaccard(new.ingredientSlugs,
   *  existing.ingredientSlugs) > `duplicateThreshold` (default 0.75). */
  existingRecipes?: { slug: string; ingredientSlugs: string[] }[];
  duplicateThreshold?: number;
  /** The slugs recipes and drafts already have: a new recipe needs one of its own. */
  takenSlugs?: ReadonlySet<string>;
  /** Their English titles, in lower case: a new recipe needs one of its own too. */
  takenTitles?: ReadonlySet<string>;
  /** The diets the run was asked for: a recipe that does not qualify is rejected. */
  requiredDiets?: DietType[];
  /** The meals the run was asked for: a recipe that is for none of them is rejected. */
  requiredMeals?: readonly string[];
}

/** Jaccard similarity of two slug sets. 1.0 = identical, 0 = disjoint. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const LLM_YAP_PATTERNS = [
  /\bnote\s*:/i,
  /\bas an ai\b/i,
  /\bi cannot\b/i,
  /^here (is|are)\b/i,
];

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateRecipeBatch(
  opts: ValidateRecipeBatchOptions,
): RecipeValidationResult {
  const { targetLocales, rawOutput, resolveSlug } = opts;
  const tolerance = opts.nutritionDeltaTolerance ?? 0.05;
  const duplicateThreshold = opts.duplicateThreshold ?? 0.75;
  const requiredDiets = opts.requiredDiets ?? [];
  const existingRecipes = opts.existingRecipes ?? [];

  const reply = readModelObject(rawOutput, MAX_BATCH_REPLY_CHARS);
  if (!reply.ok) return { ok: false, reason: 'malformed-json' };
  const root = reply.value as Raw;
  if (!Array.isArray(root.recipes)) {
    return { ok: false, reason: 'no-recipes-key' };
  }
  if (root.recipes.length === 0) {
    return { ok: false, reason: 'empty-batch' };
  }
  const rows: unknown[] = root.recipes;

  const candidates: RecipeDraftCandidate[] = [];
  const seenSlugs = new Set<string>();
  const seenTitles = new Set<string>();

  /** One recipe of the answer: what is written of it, or why nothing is. */
  const judge = (i: number): RecipeDraftCandidate | RecipeValidationFail => {
    const row = rows[i];
    const raw = isRecord(row) ? row : {};
    const written = expectString(raw.slug);
    if (!written) return { ok: false, reason: 'missing-field', key: `#${i}.slug` };
    // A slug with a letter of another alphabet in it, or a space, is taken as the plain one it means ("sauté" as "saute").
    const slug = /^[a-z0-9-]+$/.test(written) ? written : slugify(written) || written;
    const rowKey = slug;
    if (seenSlugs.has(slug)) {
      return {
        ok: false,
        reason: 'duplicate-slug-in-batch',
        key: slug,
      };
    }
    // A slug names one recipe: the data refuses a second, and a ship would
    // have to hold the draft back. Better not to write it.
    if (opts.takenSlugs?.has(slug)) return { ok: false, reason: 'slug-taken', key: slug };

    // What a model's batch is held to beyond the rules of any recipe: a step
    // with nothing in it, or one that is the model talking, means the answer
    // was written carelessly, and the call is made again.
    for (const list of Object.values(isRecord(raw.steps) ? raw.steps : {})) {
      for (const step of Array.isArray(list) ? list : []) {
        if (typeof step !== 'string') continue;
        if (step.trim().length === 0) return { ok: false, reason: 'empty-step', key: `${rowKey}.steps` };
        if (LLM_YAP_PATTERNS.some((re) => re.test(step))) return { ok: false, reason: 'llm-yap', key: `${rowKey}.steps` };
      }
    }

    const checked = checkRecipe({ ...raw, slug }, targetLocales);
    if (!checked.ok) {
      const first = checked.problems[0]!;
      return { ok: false, reason: first.rule, key: `${rowKey}.${first.path}`, details: first.message };
    }
    const { titles, descriptions, steps, servings, prepMinutes, cookMinutes, difficulty, mealTypes, ingredients } = checked.recipe;

    const requiredMeals = opts.requiredMeals ?? [];
    if (requiredMeals.length > 0 && !mealTypes.some((meal) => requiredMeals.includes(meal))) {
      return { ok: false, reason: 'meal-not-asked-for', key: slug, details: `asked for ${requiredMeals.join(', ')}` };
    }

    // Nor may two recipes share an English title, however it is cased.
    const titleKey = (titles.en ?? '').toLowerCase();
    if (seenTitles.has(titleKey)) return { ok: false, reason: 'duplicate-title-in-batch', key: slug };
    if (opts.takenTitles?.has(titleKey)) return { ok: false, reason: 'title-taken', key: slug };

    const resolved: ResolvedIngredient[] = [];
    for (const line of ingredients) {
      const res = resolveSlug(line.slug);
      if (!res) return { ok: false, reason: 'unknown-slug', key: `${rowKey}.${line.slug}` };
      resolved.push(res);
    }

    // The band the recipe falls into by its ingredients, steps and time. One
    // that is outside every band is not written.
    const stepCount = steps.en?.length ?? Object.values(steps)[0]?.length ?? 0;
    const totalMinutes = prepMinutes + cookMinutes;
    const ingredientCount = ingredients.length;
    const complexity = classifyComplexity({
      ingredientCount,
      stepCount,
      totalMinutes,
    });
    if (complexity === null) {
      return {
        ok: false,
        reason: outOfBandReason(ingredientCount, stepCount, totalMinutes),
        key: rowKey,
        details: `i=${ingredientCount} s=${stepCount} t=${totalMinutes}`,
      };
    }

    // Nutrition, allergens and diets are worked out by the engine from the
    // ingredient table. A line is checked on its own first, so that a unit
    // that cannot be converted is reported where it is written.
    const factLines = ingredients.map((line, li) => ({ quantity: line.quantity, unit: line.unit, ingredient: resolved[li]! }));
    for (const [li, line] of factLines.entries()) {
      try {
        recipeFacts([line], 1);
      } catch (err) {
        return {
          ok: false,
          reason: 'unit-conversion-failed',
          key: `${rowKey}.${ingredients[li]!.slug}`,
          details: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const facts = recipeFacts(factLines, servings);

    // A run that was asked for a diet keeps only recipes that qualify for it.
    for (const diet of requiredDiets) {
      if (!fitsDiet(facts.dietTags, diet)) {
        return {
          ok: false,
          reason: 'diet-conflict',
          key: rowKey,
          details: `asked for ${diet}, qualifies for [${facts.dietTags.join(', ')}]`,
        };
      }
    }

    // Duplicate-of-existing check. Jaccard on the ingredient slug set vs
    // every existing recipe (live + pending) and prior candidates in this
    // batch. > threshold → reject. Yogurt+apple vs yogurt+banana stays well
    // under (J = 0.33); identical sets hit J = 1.0.
    const newSlugs = ingredients.map((ing) => ing.slug);
    let bestExistingMatch: { slug: string; score: number } | null = null;
    for (const existing of existingRecipes) {
      const score = jaccard(newSlugs, existing.ingredientSlugs);
      if (score > duplicateThreshold && (!bestExistingMatch || score > bestExistingMatch.score)) {
        bestExistingMatch = { slug: existing.slug, score };
      }
    }
    for (const prior of candidates) {
      const score = jaccard(newSlugs, prior.ingredients.map((i) => i.slug));
      if (score > duplicateThreshold && (!bestExistingMatch || score > bestExistingMatch.score)) {
        bestExistingMatch = { slug: prior.slug, score };
      }
    }
    if (bestExistingMatch) {
      return {
        ok: false,
        reason: 'duplicate-of-existing',
        key: rowKey,
        details: `vs ${bestExistingMatch.slug} (J=${bestExistingMatch.score.toFixed(2)})`,
      };
    }

    const engine = {
      caloriesPerServing: facts.perServing.calories,
      proteinPerServing: facts.perServing.protein,
      fatPerServing: facts.perServing.fat,
      carbsPerServing: facts.perServing.carbs,
    };

    // 5%-delta check. Only runs when the AI volunteered numbers — most
    // models will, despite being told not to.
    const claimedKcal = numberOrNull(raw.caloriesPerServing);
    if (claimedKcal !== null && engine.caloriesPerServing > 0) {
      const delta = Math.abs(claimedKcal - engine.caloriesPerServing) / engine.caloriesPerServing;
      if (delta > tolerance) {
        return {
          ok: false,
          reason: 'invented-nutrition',
          key: rowKey,
          details: `claimed=${claimedKcal} engine=${engine.caloriesPerServing} delta=${delta.toFixed(2)}`,
        };
      }
    }

    seenSlugs.add(slug);
    seenTitles.add(titleKey);
    return {
      slug,
      titles,
      descriptions,
      steps,
      servings,
      mealTypes,
      dietTags: facts.dietTags,
      prepMinutes,
      cookMinutes,
      difficulty,
      complexity,
      ingredients,
      ...engine,
      allergens: facts.allergens,
    };
  };

  const refused: RecipeRefusal[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const judged = judge(i);
    if ('ok' in judged) refused.push({ reason: judged.reason, ...(judged.key === undefined ? {} : { key: judged.key }), ...(judged.details === undefined ? {} : { details: judged.details }) });
    else candidates.push(judged);
  }
  if (candidates.length === 0) return { ok: false, ...refused[0]! };
  return { ok: true, candidates, refused };
}

/** Pick the most specific out-of-band rejection reason. */
function outOfBandReason(
  ingredientCount: number,
  stepCount: number,
  totalMinutes: number,
): RecipeValidationReason {
  const maxBand: ComplexityBand = COMPLEXITY_BANDS[COMPLEXITY_BANDS.length - 1];
  const minBand: ComplexityBand = COMPLEXITY_BANDS[0];
  if (ingredientCount < minBand.minIngredients || ingredientCount > maxBand.maxIngredients) {
    return 'ingredient-count-out-of-bands';
  }
  if (stepCount > maxBand.maxSteps) return 'step-count-too-high';
  if (totalMinutes > maxBand.maxTotalMinutes) return 'total-time-too-high';
  return 'no-matching-complexity-band';
}

function expectString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

