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
  | 'meals-of-two-kinds'
  | 'names-what-its-list-lacks'
  | 'listed-but-not-used'
  | 'steps-differ-between-languages'
  | 'title-names-a-diet-or-band'
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
  /**
   * The ingredients of the catalogue by their English names. With them, a
   * recipe whose title or steps name one of them that its own list does not
   * hold is rejected: "season with salt" without salt among the ingredients.
   */
  catalogueNames?: readonly { slug: string; name: string }[];
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

/**
 * What the title of a recipe a model wrote may not say, nor the slug made of
 * it: a diet, which stops being true when the figures of an ingredient move;
 * a complexity band; praise. The diets a recipe suits are worked out and shown
 * beside it.
 */
const TITLE_SAYS_MORE = /\b(keto|ketogenic|low[- ]carb|high[- ]protein|vegan|vegetarian|simple|easy|quick|healthy)\b/i;

/** The meals a main dish is eaten at. Every other meal is a small one. */
const MAIN_MEALS: ReadonlySet<string> = new Set(['lunch', 'dinner']);

/** An ingredient the catalogue calls by one word, and how that word is found in a text, one of it or several. */
export interface NamedByOneWord {
  slug: string;
  /** The word without its plural ending: what the name of an ingredient that stands in for it holds. */
  stem: string;
  found: RegExp;
}

/**
 * The ingredients a text can be held to: those whose English name is one
 * word ("Salt", "Lemon", "Mushrooms"). A name of several words ("Black
 * pepper", "Olive oil") is left out: its last word alone ("pepper", "oil")
 * names other things too.
 */
export function namedByOneWord(names: readonly { slug: string; name: string }[]): NamedByOneWord[] {
  return names
    .map(({ slug, name }) => ({ slug, word: name.trim().toLowerCase() }))
    .filter(({ word }) => /^[a-z]{3,}$/.test(word))
    .map(({ slug, word }) => {
      const [stem, endings] = word.endsWith('ies') ? [word.slice(0, -3), '(?:y|ies)'] : word.endsWith('s') ? [word.slice(0, -1), 's?'] : [word, '(?:s|es)?'];
      return { slug, stem, found: new RegExp(`\\b${stem}${endings}\\b`) };
    });
}

/**
 * The first ingredient of the catalogue that the text names and the list
 * does not hold, or null. An ingredient of the list whose own name holds the
 * word answers for it: peanut butter for "butter", canned tomatoes for
 * "tomato".
 */
export function namedButNotListed(text: string, listed: readonly string[], named: readonly NamedByOneWord[], nameOf: ReadonlyMap<string, string>): string | null {
  const lower = text.toLowerCase();
  const have = listed.map((slug) => (nameOf.get(slug) ?? slug).toLowerCase());
  for (const { slug, stem, found } of named) {
    if (listed.includes(slug) || !found.test(lower)) continue;
    if (!have.some((name) => name.includes(stem))) return slug;
  }
  return null;
}

/** Words of an ingredient's name that say what it is like, not what it is: "white" rice, a "large" egg. */
const DESCRIBING = new Set(['large', 'small', 'whole', 'grain', 'white', 'black', 'red', 'green', 'yellow', 'brown', 'sweet', 'sour', 'heavy', 'light', 'smoked', 'canned', 'rolled', 'dried', 'fresh', 'frozen', 'ground', 'extra', 'virgin', 'raw', 'cooked', 'plain', 'wild', 'baby', 'fillet', 'breast', 'thigh']);

/**
 * The first ingredient of the list that no step uses, or null. An ingredient
 * is used where a step names a word of its English name ("the oil" for olive
 * oil, "the eggs" for a large egg); a word that only says what it is like
 * ("white", "large") uses nothing. An ingredient without a name is passed over.
 */
export function listedButNotUsed(steps: string, listed: readonly string[], nameOf: ReadonlyMap<string, string>): string | null {
  const lower = steps.toLowerCase();
  for (const slug of listed) {
    const words = (nameOf.get(slug) ?? '').toLowerCase().split(/[^a-z]+/).filter((word) => word.length >= 3 && !DESCRIBING.has(word));
    if (words.length === 0) continue;
    const used = words.some((word) => new RegExp(`\\b${word.endsWith('ies') ? word.slice(0, -3) : word.endsWith('s') ? word.slice(0, -1) : word}`).test(lower));
    if (!used) return slug;
  }
  return null;
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
  const named = namedByOneWord(opts.catalogueNames ?? []);
  const nameOf = new Map((opts.catalogueNames ?? []).map(({ slug, name }) => [slug, name]));

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

    // Each language tells the same dish step by step. A language with fewer
    // steps than another lost some on the way: an answer that broke off.
    const stepCounts = Object.entries(steps).map(([locale, list]) => `${locale} ${list.length}`);
    if (new Set(Object.values(steps).map((list) => list.length)).size > 1) {
      return { ok: false, reason: 'steps-differ-between-languages', key: `${rowKey}.steps`, details: stepCounts.join(', ') };
    }

    const requiredMeals = opts.requiredMeals ?? [];
    if (requiredMeals.length > 0 && !mealTypes.some((meal) => requiredMeals.includes(meal))) {
      return { ok: false, reason: 'meal-not-asked-for', key: slug, details: `asked for ${requiredMeals.join(', ')}` };
    }
    // A dish is a main one or a small one. A main dish that also says it is
    // a snack or a breakfast was stretched to fit the meal that was asked
    // for, and a plan would serve half a dinner between meals.
    if (mealTypes.some((meal) => MAIN_MEALS.has(meal)) && mealTypes.some((meal) => !MAIN_MEALS.has(meal))) {
      return { ok: false, reason: 'meals-of-two-kinds', key: slug, details: `${mealTypes.join(', ')}: a main dish is no breakfast and no snack` };
    }

    if (TITLE_SAYS_MORE.test(`${slug} ${titles.en ?? ''}`)) {
      return { ok: false, reason: 'title-names-a-diet-or-band', key: slug, details: 'a title names the dish: what it is made of and how' };
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

    // The figures, the allergens and the shopping list of a recipe are all
    // worked out from its list. A title, a description or a step that names an
    // ingredient the list does not hold describes another dish than the one
    // that is counted, and so does a list with an ingredient no step uses.
    const lacking = namedButNotListed([titles.en ?? '', descriptions.en ?? '', ...(steps.en ?? [])].join(' '), ingredients.map((line) => line.slug), named, nameOf);
    if (lacking) return { ok: false, reason: 'names-what-its-list-lacks', key: `${rowKey}.${lacking}` };
    const unused = listedButNotUsed((steps.en ?? []).join(' '), ingredients.map((line) => line.slug), nameOf);
    if (unused) return { ok: false, reason: 'listed-but-not-used', key: `${rowKey}.${unused}` };

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

