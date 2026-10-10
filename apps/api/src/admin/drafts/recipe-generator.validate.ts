// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Recipe draft post-validator.
 *
 * Walks the AI's JSON response and rejects rows we wouldn't want a human
 * reviewer to even see. Every recipe goes through the same gate so the
 * curation queue is never polluted with structurally-broken drafts:
 *
 *   - Strict JSON shape parsing — every locale in `targetLocales` must be
 *     present in titles / descriptions / steps. Missing locale rejected.
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

export type RecipeValidationReason =
  | 'malformed-json'
  | 'no-recipes-key'
  | 'empty-batch'
  | 'missing-field'
  | 'missing-locale'
  | 'empty-step'
  | 'unknown-slug'
  | 'duplicate-slug-in-batch'
  | 'ingredient-count-out-of-bands'
  | 'step-count-too-high'
  | 'total-time-too-high'
  | 'no-matching-complexity-band'
  | 'diet-conflict'
  | 'unit-conversion-failed'
  | 'invented-nutrition'
  | 'llm-yap'
  | 'invalid-quantity'
  | 'invalid-unit'
  | 'invalid-difficulty'
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

export interface RecipeValidationOk {
  ok: true;
  candidates: RecipeDraftCandidate[];
}
export interface RecipeValidationFail {
  ok: false;
  reason: RecipeValidationReason;
  /** Identifies the recipe (slug or index) and field that triggered the
   *  failure. */
  key?: string;
  details?: string;
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
  /** The diets the run was asked for: a recipe that does not qualify is rejected. */
  requiredDiets?: DietType[];
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

  const candidates: RecipeDraftCandidate[] = [];
  const seenSlugs = new Set<string>();

  for (let i = 0; i < root.recipes.length; i += 1) {
    const raw = root.recipes[i] as Raw;
    const rowKey = (raw.slug as string | undefined) ?? `#${i}`;

    const slug = expectString(raw.slug);
    if (!slug) return missing(rowKey, 'slug');
    if (seenSlugs.has(slug)) {
      return {
        ok: false,
        reason: 'duplicate-slug-in-batch',
        key: slug,
      };
    }

    const titles = expectLocaleMap(raw.titles, targetLocales);
    if (titles === null) return { ok: false, reason: 'missing-locale', key: `${rowKey}.titles` };
    const descriptions = expectLocaleMap(raw.descriptions, targetLocales);
    if (descriptions === null)
      return { ok: false, reason: 'missing-locale', key: `${rowKey}.descriptions` };
    const steps = expectLocaleStepsMap(raw.steps, targetLocales);
    if (steps === null) return { ok: false, reason: 'missing-locale', key: `${rowKey}.steps` };

    for (const arr of Object.values(steps)) {
      for (const s of arr) {
        if (s.trim().length === 0)
          return { ok: false, reason: 'empty-step', key: `${rowKey}.steps` };
        if (LLM_YAP_PATTERNS.some((re) => re.test(s)))
          return { ok: false, reason: 'llm-yap', key: `${rowKey}.steps` };
      }
    }

    const servings = expectInt(raw.servings);
    const prepMinutes = expectInt(raw.prepMinutes);
    const cookMinutes = expectInt(raw.cookMinutes);
    if (servings === null || servings < 1)
      return missing(rowKey, 'servings');
    if (prepMinutes === null || prepMinutes < 0)
      return missing(rowKey, 'prepMinutes');
    if (cookMinutes === null || cookMinutes < 0)
      return missing(rowKey, 'cookMinutes');

    const difficulty = expectString(raw.difficulty) as 'easy' | 'medium' | 'hard' | null;
    if (difficulty !== 'easy' && difficulty !== 'medium' && difficulty !== 'hard') {
      return {
        ok: false,
        reason: 'invalid-difficulty',
        key: `${rowKey}.difficulty`,
        details: difficulty === null ? 'missing or empty' : `got "${String(raw.difficulty)}"`,
      };
    }

    const mealTypes = expectStringArray(raw.mealTypes);
    if (mealTypes === null || mealTypes.length === 0)
      return missing(rowKey, 'mealTypes');

    const rawIngredients = Array.isArray(raw.ingredients) ? raw.ingredients : null;
    if (!rawIngredients || rawIngredients.length === 0)
      return missing(rowKey, 'ingredients');

    const ingredients: RecipeDraftCandidate['ingredients'] = [];
    const resolved: ResolvedIngredient[] = [];
    for (const line of rawIngredients) {
      const l = line as Raw;
      const lSlug = expectString(l.slug);
      const quantity = typeof l.quantity === 'number' && Number.isFinite(l.quantity) ? l.quantity : null;
      const unit = expectString(l.unit) as 'g' | 'ml' | 'piece' | null;
      if (!lSlug)
        return { ok: false, reason: 'missing-field', key: `${rowKey}.ingredient.slug` };
      if (quantity === null || quantity <= 0)
        return { ok: false, reason: 'invalid-quantity', key: `${rowKey}.${lSlug}` };
      if (unit !== 'g' && unit !== 'ml' && unit !== 'piece')
        return {
          ok: false,
          reason: 'invalid-unit',
          key: `${rowKey}.${lSlug}.unit`,
          details: `got "${String(l.unit)}" — must be "g" | "ml" | "piece"`,
        };

      const res = resolveSlug(lSlug);
      if (!res)
        return { ok: false, reason: 'unknown-slug', key: `${rowKey}.${lSlug}` };

      const note = typeof l.note === 'string' && l.note.trim().length > 0 ? l.note.trim() : null;
      ingredients.push({ slug: lSlug, quantity, unit, note });
      resolved.push(res);
    }

    // Complexity band check (D8). We auto-tag, then reject if the row is
    // outside every band — that's the "not willing to ship without manual
    // override" guard.
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
    candidates.push({
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
    });
  }

  return { ok: true, candidates };
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

function missing(rowKey: string, field: string): RecipeValidationFail {
  return { ok: false, reason: 'missing-field', key: `${rowKey}.${field}` };
}

function expectString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function expectStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== 'string') return null;
    const trimmed = s.trim();
    if (trimmed.length === 0) return null;
    out.push(trimmed);
  }
  return out;
}

function expectInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) ? v : null;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function expectLocaleMap(v: unknown, locales: string[]): Record<string, string> | null {
  if (typeof v !== 'object' || v === null) return null;
  const obj = v as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const locale of locales) {
    const value = obj[locale];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    out[locale] = trimmed;
  }
  return out;
}

function expectLocaleStepsMap(
  v: unknown,
  locales: string[],
): Record<string, string[]> | null {
  if (typeof v !== 'object' || v === null) return null;
  const obj = v as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const locale of locales) {
    const value = obj[locale];
    if (!Array.isArray(value) || value.length === 0) return null;
    const cleaned: string[] = [];
    for (const s of value) {
      if (typeof s !== 'string') return null;
      cleaned.push(s);
    }
    out[locale] = cleaned;
  }
  return out;
}
