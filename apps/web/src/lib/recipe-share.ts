// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * A recipe as it is sent to somebody who is to cook it: what it is called,
 * what it takes in the amounts it was opened with, and how it is made. No
 * figures, and nothing of whoever sends it: no profile, target or diet. Its
 * words come translated, so a text and a document say the same.
 */
export interface SharedRecipe {
  title: string;
  /** What the amounts are for: "Ingredients for 2 servings". */
  ingredientsHeading: string;
  ingredients: { name: string; amount: string; note: string | null }[];
  stepsHeading: string;
  steps: string[];
  /** Said under it: where it is from and its licence, and that a model had a part in it. */
  notes: string[];
}

/**
 * The recipe as a text for a message. Its spaces are plain, as a message's
 * are: the no-break spaces of the page hold its own lines, not those of a
 * message.
 */
export function recipeText(recipe: SharedRecipe): string {
  return [
    recipe.title,
    '',
    `${recipe.ingredientsHeading}:`,
    ...recipe.ingredients.map(
      ({ name, amount, note }) => `- ${name}: ${amount}${note ? ` — ${note}` : ''}`,
    ),
    '',
    `${recipe.stepsHeading}:`,
    ...recipe.steps.map((step, index) => `${index + 1}. ${step}`),
    ...(recipe.notes.length > 0 ? ['', ...recipe.notes] : []),
  ]
    .join('\n')
    .replace(/[\u00a0\u202f]/g, ' ');
}

/**
 * A name for the file of a recipe, without its extension: its title in plain
 * letters, digits and dashes, which any mail or chat keeps as it is, or
 * "recipe" where none of the title is left.
 */
export function fileNameOf(title: string): string {
  const plain = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return plain || 'recipe';
}
