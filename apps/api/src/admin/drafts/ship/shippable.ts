// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A draft as it leaves the queue. Whichever way it ships (into this
 * instance's own tables, into a bundle, into a pull request) it is held to
 * the rules of every recipe once more, and what ships is the checked content:
 * text made plain, and only in the languages the draft was reviewed in. A
 * draft that was stored before a rule existed, or was changed behind the
 * queue's back, stays where it is and the reason is reported.
 */
import { checkIngredientName, checkRecipe, type RecipeProblem } from '../../../recipes/recipe-rules.js';
import type { IngredientOverrideEntry } from './ingredient-overrides.writer.js';
import type { ShippedRecipe } from './recipe-batches.writer.js';

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
  ingredientsJson: unknown;
}

export type Shippable<T> = { ok: true; content: T } | { ok: false; reason: string; problems: RecipeProblem[] };

/** A draft that did not ship: which one, and why, as `<rule>` or `<rule>: <detail>`. */
export interface Skipped {
  draftId: string;
  /** The draft's slug, or the slug of the ingredient it names. */
  slug: string;
  reason: string;
}

const reasonOf = (problems: RecipeProblem[]): string => `invalid-draft: ${problems.map((problem) => `${problem.path}: ${problem.rule}`).join('; ')}`;

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
  const recipe = checked.recipe;
  return {
    ok: true,
    content: {
      slug: recipe.slug!,
      title: recipe.titles,
      description: recipe.descriptions,
      servings: recipe.servings,
      mealTypes: recipe.mealTypes,
      prepMinutes: recipe.prepMinutes,
      cookMinutes: recipe.cookMinutes,
      difficulty: recipe.difficulty,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
    },
  };
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
