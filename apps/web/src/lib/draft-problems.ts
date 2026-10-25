// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { INGREDIENT_NAME_LIMITS, RECIPE_LIMITS } from '@diet-app/shared/constants';

/**
 * What the API found wrong with the content of a draft: where, and which
 * rule. A refusal with the code `DRAFT_INVALID` carries a list of these.
 */
export interface DraftProblem {
  /** `titles.pl`, `steps.en[3]`, `ingredients[0].quantity`, `servings`. */
  path: string;
  rule: string;
}

/** The problems a refusal carries under `details`, or none. */
export function draftProblemsOf(details: Record<string, unknown> | undefined): DraftProblem[] {
  const list = details?.problems;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (entry): entry is DraftProblem =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as DraftProblem).path === 'string' &&
        typeof (entry as DraftProblem).rule === 'string',
    )
    .map(({ path, rule }) => ({ path, rule }));
}

/** The fields a problem can be about, as the messages name them. */
export type DraftField =
  | 'title'
  | 'description'
  | 'steps'
  | 'step'
  | 'ingredients'
  | 'ingredient'
  | 'ingredientNote'
  | 'servings'
  | 'prepMinutes'
  | 'cookMinutes'
  | 'mealTypes'
  | 'difficulty'
  | 'slug'
  | 'name'
  | 'storageHint'
  | 'other';

export interface DraftPlace {
  field: DraftField;
  /** The language of a text, in upper case; empty for what has none. */
  locale: string;
  /** The place in a list, counted from one; zero for what is in none. */
  n: number;
}

const TEXT_FIELDS: Record<string, DraftField> = {
  titles: 'title',
  descriptions: 'description',
  name: 'name',
  storageHint: 'storageHint',
};
const PLAIN_FIELDS: readonly DraftField[] = [
  'servings',
  'prepMinutes',
  'cookMinutes',
  'difficulty',
  'slug',
];

/** What a problem's path names: the field, its language, its place in a list. */
export function placeOf(path: string): DraftPlace {
  const [head = '', second = ''] = path.split('.');
  const [name = '', index] = head.split(/[[\]]/);
  const n = index === undefined ? 0 : Number(index) + 1;

  if (name in TEXT_FIELDS) return { field: TEXT_FIELDS[name]!, locale: second.toUpperCase(), n: 0 };
  if (name === 'steps') {
    const [locale = '', step] = second.split(/[[\]]/);
    return step === undefined
      ? { field: 'steps', locale: locale.toUpperCase(), n: 0 }
      : { field: 'step', locale: locale.toUpperCase(), n: Number(step) + 1 };
  }
  if (name === 'ingredients') {
    if (n === 0) return { field: 'ingredients', locale: '', n: 0 };
    return { field: second === 'note' ? 'ingredientNote' : 'ingredient', locale: '', n };
  }
  if (name === 'mealTypes') return { field: 'mealTypes', locale: '', n: 0 };
  if ((PLAIN_FIELDS as readonly string[]).includes(name))
    return { field: name as DraftField, locale: '', n: 0 };
  return { field: 'other', locale: '', n: 0 };
}

/** The number a rule's message names: the longest text, the most steps, the largest count. */
export function limitOf(rule: string, field: DraftField): number {
  switch (rule) {
    case 'text-too-long':
      return (
        {
          title: RECIPE_LIMITS.title,
          description: RECIPE_LIMITS.description,
          step: RECIPE_LIMITS.step,
          ingredientNote: RECIPE_LIMITS.note,
          name: INGREDIENT_NAME_LIMITS.name,
          storageHint: INGREDIENT_NAME_LIMITS.storageHint,
        }[field as string] ?? 0
      );
    case 'too-many-steps':
      return RECIPE_LIMITS.steps;
    case 'too-many-ingredients':
      return RECIPE_LIMITS.ingredients;
    case 'servings-out-of-range':
      return RECIPE_LIMITS.servings;
    case 'time-out-of-range':
      return RECIPE_LIMITS.minutes;
    default:
      return 0;
  }
}
