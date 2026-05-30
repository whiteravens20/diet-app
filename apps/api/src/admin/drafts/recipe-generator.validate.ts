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
 *   - Diet-tag vs ingredient `dietCompatibility` cross-check.
 *   - Allergen autodetection: union of ingredient allergens is stored,
 *     not the AI's claim.
 *   - Engine-recomputed nutrition. The draft stores engine values; AI is
 *     never trusted for numbers.
 *   - 5%-delta sanity: if AI volunteered nutrition values and they diverge
 *     from engine values by > 5 %, reject — the AI is probably lying
 *     about portion sizes.
 *   - Complexity auto-tag via `classifyComplexity`. Rows outside every
 *     band are rejected.
 *
 * The validator is injected with `resolveSlug` so unit tests can stub
 * the catalogue without a live DB.
 */
import { extractJson } from '../translate/validate.js';
import { nutritionFor, toCanonical } from '../../engine/units.js';
import {
  classifyComplexity,
  type ComplexityBand,
  COMPLEXITY_BANDS,
} from './recipe-generator.complexity.js';
import type { Complexity } from '@diet-app/shared';

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
  | 'invalid-difficulty';

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
}

const LLM_YAP_PATTERNS = [
  /\bnote\s*:/i,
  /\bas an ai\b/i,
  /\bi cannot\b/i,
  /^here (is|are)\b/i,
];

/** Diet tags that act as ingredient exclusions — if a recipe carries the tag,
 *  every ingredient must list it in `dietCompatibility`. Style/target tags
 *  like `high_protein`, `balanced`, `mediterranean` are not cross-checked. */
const RESTRICTIVE_DIET_TAGS = new Set(['vegan', 'vegetarian', 'keto', 'low_carb']);

type Raw = Record<string, unknown>;

export function validateRecipeBatch(
  opts: ValidateRecipeBatchOptions,
): RecipeValidationResult {
  const { targetLocales, rawOutput, resolveSlug } = opts;
  const tolerance = opts.nutritionDeltaTolerance ?? 0.05;

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawOutput));
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'malformed-json' };
  }
  const root = parsed as Raw;
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
    const dietTags = expectStringArray(raw.dietTags) ?? [];

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

    // Diet honesty — only *restrictive* diets are cross-checked. A vegan
    // recipe cannot contain a non-vegan ingredient; a keto recipe cannot
    // contain a carb-heavy slug. But `high_protein`, `balanced`, and
    // `mediterranean` are recipe-level *style* tags (high-protein recipes
    // routinely include olive oil; mediterranean recipes include lemon),
    // so they are not per-ingredient guarantees.
    for (const tag of dietTags) {
      if (!RESTRICTIVE_DIET_TAGS.has(tag)) continue;
      for (let li = 0; li < ingredients.length; li += 1) {
        if (!resolved[li].dietCompatibility.includes(tag)) {
          return {
            ok: false,
            reason: 'diet-conflict',
            key: `${rowKey}.${ingredients[li].slug}`,
            details: `dietTag=${tag}`,
          };
        }
      }
    }

    // Allergen autodetection: union of ingredient allergens, sorted so
    // diffs are stable.
    const allergens = new Set<string>();
    for (const r of resolved) for (const a of r.allergens) allergens.add(a);
    const allergenList = [...allergens].sort();

    // Engine recompute.
    let calories = 0;
    let protein = 0;
    let fat = 0;
    let carbs = 0;
    for (let li = 0; li < ingredients.length; li += 1) {
      const line = ingredients[li];
      const r = resolved[li];
      let canonical: number;
      try {
        canonical = toCanonical(line.quantity, line.unit, {
          canonicalUnit: r.canonicalUnit,
          gramsPerPiece: r.gramsPerPiece,
          density: r.density,
        });
      } catch (err) {
        return {
          ok: false,
          reason: 'unit-conversion-failed',
          key: `${rowKey}.${line.slug}`,
          details: err instanceof Error ? err.message : String(err),
        };
      }
      const n = nutritionFor(canonical, {
        calories: r.caloriesPer100,
        protein: r.proteinPer100,
        fat: r.fatPer100,
        carbs: r.carbsPer100,
      });
      calories += n.calories;
      protein += n.protein;
      fat += n.fat;
      carbs += n.carbs;
    }
    const engine = {
      caloriesPerServing: Math.round(calories / servings),
      proteinPerServing: Math.round(protein / servings),
      fatPerServing: Math.round(fat / servings),
      carbsPerServing: Math.round(carbs / servings),
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
      dietTags,
      prepMinutes,
      cookMinutes,
      difficulty,
      complexity,
      ingredients,
      ...engine,
      allergens: allergenList,
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
