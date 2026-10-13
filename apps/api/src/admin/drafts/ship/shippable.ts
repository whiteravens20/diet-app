// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A draft as it leaves the queue. Whichever way it ships (into this
 * instance's own tables, into a bundle, into a pull request) it is held to
 * the rules of every recipe once more, and what ships is the checked content:
 * text made plain, and only in the languages the draft was reviewed in. A
 * draft that was stored before a rule existed, or was changed behind the
 * queue's back, stays where it is and the reason is reported.
 */
import { Cuisine } from '@diet-app/shared';
import { checkIngredientName, checkRecipe, type CheckedRecipe, type RecipeProblem } from '../../../recipes/recipe-rules.js';
import type { IngredientOverrideEntry } from './ingredient-overrides.writer.js';
import { ShippedRecipe } from './recipe-batches.writer.js';

/** The columns of a recipe draft that ship. */
export interface RecipeDraftContent {
  slug: string;
  titles: unknown;
  descriptions: unknown;
  steps: unknown;
  locales: string[];
  servings: number;
  mealTypes: string[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: string;
  cuisine?: string | null;
  ingredientsJson: unknown;
  /** Where a draft that was taken in from somewhere else is from, and its licence. */
  provenanceUrl?: string | null;
  provenanceLicense?: string | null;
}

export type Shippable<T> = { ok: true; content: T } | { ok: false; reason: string; problems: RecipeProblem[] };

/** A draft that did not ship: which one, and why, as `<rule>` or `<rule>: <detail>`. */
export interface Skipped {
  draftId: string;
  /** The draft's slug, or the slug of the ingredient it names. */
  slug: string;
  reason: string;
}

/** No approved draft may ship: each of them was held back, and here is why. */
export class NothingShips extends Error {
  constructor(readonly skipped: Skipped[]) {
    super('NO_VALID_DRAFTS');
  }
}

const reasonOf = (problems: RecipeProblem[]): string => `invalid-draft: ${problems.map((problem) => `${problem.path}: ${problem.rule}`).join('; ')}`;

/**
 * Where a recipe is from, as the data files say it: nothing for a recipe that
 * names no licence. An address that is none is left out and the licence
 * stays: the licence is what passing the recipe on depends on.
 */
function sourceOf(from: unknown): ShippedRecipe['source'] {
  const source = ShippedRecipe.shape.source.safeParse(from);
  if (source.success) return source.data;
  const license = typeof from === 'object' && from !== null ? (from as { license?: unknown }).license : undefined;
  const alone = ShippedRecipe.shape.source.safeParse({ license });
  return alone.success ? alone.data : undefined;
}

/** A checked recipe in the shape of the catalogue's data files. */
function inDataShape(recipe: CheckedRecipe, tagged: unknown, from: unknown): ShippedRecipe {
  const cuisine = Cuisine.safeParse(tagged).data;
  const source = sourceOf(from);
  return {
    slug: recipe.slug!,
    title: recipe.titles,
    description: recipe.descriptions,
    servings: recipe.servings,
    mealTypes: recipe.mealTypes,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    difficulty: recipe.difficulty,
    // Left out for a recipe of no cuisine in particular, as the curated file leaves it out.
    ...(cuisine ? { cuisine } : {}),
    // A line without a note leaves the field out, as the curated file does: the catalogue's reader takes a text there or nothing.
    ingredients: recipe.ingredients.map(({ note, ...line }) => (note ? { ...line, note } : line)),
    steps: recipe.steps,
    ...(source ? { source } : {}),
  };
}

/** The recipe a draft ships as, or why it does not ship. */
export function shippableRecipe(draft: RecipeDraftContent): Shippable<ShippedRecipe> {
  const checked = checkRecipe(
    {
      slug: draft.slug,
      titles: draft.titles,
      descriptions: draft.descriptions,
      steps: draft.steps,
      servings: draft.servings,
      mealTypes: draft.mealTypes,
      prepMinutes: draft.prepMinutes,
      cookMinutes: draft.cookMinutes,
      difficulty: draft.difficulty,
      ingredients: draft.ingredientsJson,
    },
    draft.locales,
  );
  if (!checked.ok) return { ok: false, reason: reasonOf(checked.problems), problems: checked.problems };
  const from = draft.provenanceLicense ? { ...(draft.provenanceUrl ? { url: draft.provenanceUrl } : {}), license: draft.provenanceLicense } : undefined;
  return { ok: true, content: inDataShape(checked.recipe, draft.cuisine, from) };
}

/**
 * The recipe a row of a batch file is, or why it is none. The row is what a
 * ship wrote, read back from a file anybody may have edited since: it is in
 * the languages its title is in, and it is held to the rules as a draft is.
 */
export function recipeOfBatchRow(row: unknown): Shippable<ShippedRecipe> {
  const fields: Record<string, unknown> = typeof row === 'object' && row !== null && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
  const title = fields.title;
  const locales = typeof title === 'object' && title !== null && !Array.isArray(title) ? Object.keys(title) : [];
  const checked = checkRecipe({ ...fields, titles: title, descriptions: fields.description }, locales.includes('en') ? locales : ['en', ...locales]);
  if (!checked.ok) return { ok: false, reason: reasonOf(checked.problems), problems: checked.problems };
  if (checked.recipe.slug === null) {
    const problems: RecipeProblem[] = [{ path: 'slug', rule: 'missing-field', message: 'slug is missing' }];
    return { ok: false, reason: reasonOf(problems), problems };
  }
  return { ok: true, content: inDataShape(checked.recipe, fields.cuisine, fields.source) };
}

/** The names a draft ships, for its own languages and no other, or why it does not ship. */
export function shippableIngredientName(draft: { suggestions: unknown; locales: string[] }): Shippable<IngredientOverrideEntry> {
  const suggestions = typeof draft.suggestions === 'object' && draft.suggestions !== null ? (draft.suggestions as Record<string, unknown>) : {};
  const checked = checkIngredientName(suggestions, draft.locales);
  return checked.ok ? { ok: true, content: checked.suggestion } : { ok: false, reason: reasonOf(checked.problems), problems: checked.problems };
}

/** Split `drafts` into what ships and what is held back, in their order. */
export function sortForShipping<D extends { id: string }, T>(
  drafts: readonly D[],
  shippable: (draft: D) => Shippable<T>,
  slugOf: (draft: D) => string,
): { shipping: { draft: D; content: T }[]; skipped: Skipped[] } {
  const shipping: { draft: D; content: T }[] = [];
  const skipped: Skipped[] = [];
  for (const draft of drafts) {
    const result = shippable(draft);
    if (result.ok) shipping.push({ draft, content: result.content });
    else skipped.push({ draftId: draft.id, slug: slugOf(draft), reason: result.reason });
  }
  return { shipping, skipped };
}
