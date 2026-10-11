// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What a recipe and the name of an ingredient may hold, whoever wrote them: a
 * model in a batch run, a model asked by one user, an administrator or a
 * reviewer editing a draft. One set of rules, applied wherever such content
 * comes in and once more before it is shipped.
 *
 * The text is plain text. It is made one line (line breaks, tabs and control
 * characters become a space) and then refused when it holds an angle bracket
 * or a character that hides or reorders what is read: every client shows the
 * text as it is, so markup has no use, and refusing it here means no client
 * has to be trusted to escape it.
 *
 * Pure: nothing here knows the catalogue. Whether a slug names an ingredient,
 * and what the recipe's nutrition, allergens and diets are, is worked out
 * from the ingredient table by whoever calls this.
 */
import { INGREDIENT_NAME_LIMITS, MealType, RECIPE_LIMITS, Unit, type Difficulty, type IngredientNameSuggestion } from '@diet-app/shared';
import { plainLine } from '../ai/model-json.js';

export type RecipeRule =
  | 'missing-field'
  | 'missing-locale'
  | 'text-too-long'
  | 'markup'
  | 'too-many-steps'
  | 'too-many-ingredients'
  | 'invalid-slug'
  | 'invalid-quantity'
  | 'quantity-too-large'
  | 'invalid-unit'
  | 'invalid-difficulty'
  | 'invalid-meal-type'
  | 'servings-out-of-range'
  | 'time-out-of-range';

export interface RecipeProblem {
  /** Where: `titles.pl`, `steps.en[3]`, `ingredients[0].quantity`. */
  path: string;
  rule: RecipeRule;
  /** The same in a sentence, for a log or a client without a text of its own for the rule. */
  message: string;
}

/** A recipe that passed, with its text cleaned and held for its own languages only. */
export interface CheckedRecipe {
  /** Null for a recipe that has none: one a user asked a model for. */
  slug: string | null;
  titles: Record<string, string>;
  descriptions: Record<string, string>;
  steps: Record<string, string[]>;
  servings: number;
  mealTypes: MealType[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: Difficulty;
  ingredients: { slug: string; quantity: number; unit: Unit; note: string | null }[];
}

export type RecipeCheck = { ok: true; recipe: CheckedRecipe } | { ok: false; problems: RecipeProblem[] };
export type IngredientNameCheck = { ok: true; suggestion: IngredientNameSuggestion } | { ok: false; problems: RecipeProblem[] };

/** Lower-case words and numbers joined by single hyphens: what a slug in the data looks like. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * What plain text may not hold: angle brackets, the zero-width space, and the
 * characters that override or isolate the direction of text.
 */
const NOT_PLAIN = /[<>\u200b\u202a-\u202e\u2066-\u2069]/;
const DIFFICULTIES: readonly string[] = ['easy', 'medium', 'hard'];
/**
 * An ingredient's slug is made from its name in the source, and some of those
 * are a long sentence: the bound only keeps nonsense out, the catalogue decides.
 */
const INGREDIENT_SLUG_MAX = 200;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type Text = { text: string } | { rule: 'text-too-long' | 'markup' } | null;

/** `value` as one plain line of at most `max` characters; null when it is not text or nothing is left of it. */
function plainText(value: unknown, max: number): Text {
  if (typeof value !== 'string') return null;
  // Megabytes are not looked at twice.
  if (value.length > max * 10) return { rule: 'text-too-long' };
  const line = plainLine(value);
  if (line === null) return null;
  if (line.length > max) return { rule: 'text-too-long' };
  return NOT_PLAIN.test(line) ? { rule: 'markup' } : { text: line };
}

const sentence = (path: string, rule: RecipeRule, max?: number): string => {
  switch (rule) {
    case 'missing-field':
      return `${path} is missing`;
    case 'missing-locale':
      return `${path} is missing or empty`;
    case 'text-too-long':
      return `${path} is longer than ${max} characters`;
    case 'markup':
      return `${path} holds markup or a hidden character; only plain text is taken`;
    case 'too-many-steps':
      return `${path} has more than ${RECIPE_LIMITS.steps} steps`;
    case 'too-many-ingredients':
      return `${path} has more than ${RECIPE_LIMITS.ingredients} lines`;
    case 'invalid-slug':
      return `${path} is not a slug: lower-case words joined by hyphens, at most ${RECIPE_LIMITS.slug} characters`;
    case 'invalid-quantity':
      return `${path} is not a positive number`;
    case 'quantity-too-large':
      return `${path} is more than one serving can hold`;
    case 'invalid-unit':
      return `${path} is not one of ${Unit.options.join(', ')}`;
    case 'invalid-difficulty':
      return `${path} is not one of ${DIFFICULTIES.join(', ')}`;
    case 'invalid-meal-type':
      return `${path} is not a meal the planner knows`;
    case 'servings-out-of-range':
      return `${path} is not a whole number from 1 to ${RECIPE_LIMITS.servings}`;
    case 'time-out-of-range':
      return `${path} is not a whole number of minutes from 0 to ${RECIPE_LIMITS.minutes}`;
  }
};

/** Collects the problems of one check. */
function problemList(): { problems: RecipeProblem[]; add: (path: string, rule: RecipeRule, max?: number) => void } {
  const problems: RecipeProblem[] = [];
  return { problems, add: (path, rule, max) => problems.push({ path, rule, message: sentence(path, rule, max) }) };
}

/**
 * Check what a recipe holds. `locales` are the languages the recipe is in:
 * each needs a title, a description and steps, and text in any other language
 * is left out. Every problem is named, not only the first.
 */
export function checkRecipe(input: Record<string, unknown>, locales: readonly string[]): RecipeCheck {
  const { problems, add } = problemList();

  let slug: string | null = null;
  if (input.slug !== undefined && input.slug !== null) {
    if (typeof input.slug === 'string' && input.slug.length <= RECIPE_LIMITS.slug && SLUG.test(input.slug)) slug = input.slug;
    else add('slug', 'invalid-slug');
  }

  const textsOf = (field: 'titles' | 'descriptions', max: number): Record<string, string> => {
    const source = isObject(input[field]) ? input[field] : {};
    const out: Record<string, string> = {};
    for (const locale of locales) {
      const text = plainText(source[locale], max);
      if (text === null) add(`${field}.${locale}`, 'missing-locale');
      else if ('rule' in text) add(`${field}.${locale}`, text.rule, max);
      else out[locale] = text.text;
    }
    return out;
  };
  const titles = textsOf('titles', RECIPE_LIMITS.title);
  const descriptions = textsOf('descriptions', RECIPE_LIMITS.description);

  const steps: Record<string, string[]> = {};
  const stepSource = isObject(input.steps) ? input.steps : {};
  for (const locale of locales) {
    const list = stepSource[locale];
    const kept: string[] = [];
    let sound = true;
    for (const [index, entry] of (Array.isArray(list) ? list : []).entries()) {
      const text = plainText(entry, RECIPE_LIMITS.step);
      // A step with nothing in it is dropped: it says nothing either way.
      if (text === null) continue;
      if ('rule' in text) {
        add(`steps.${locale}[${index}]`, text.rule, RECIPE_LIMITS.step);
        sound = false;
      } else kept.push(text.text);
    }
    if (!sound) continue;
    if (kept.length === 0) add(`steps.${locale}`, 'missing-locale');
    else if (kept.length > RECIPE_LIMITS.steps) add(`steps.${locale}`, 'too-many-steps');
    else steps[locale] = kept;
  }

  const whole = (field: 'servings' | 'prepMinutes' | 'cookMinutes', min: number, max: number, rule: RecipeRule): number | null => {
    const value = input[field];
    if (value === undefined || value === null) {
      add(field, 'missing-field');
      return null;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
    add(field, rule);
    return null;
  };
  const servings = whole('servings', 1, RECIPE_LIMITS.servings, 'servings-out-of-range');
  const prepMinutes = whole('prepMinutes', 0, RECIPE_LIMITS.minutes, 'time-out-of-range');
  const cookMinutes = whole('cookMinutes', 0, RECIPE_LIMITS.minutes, 'time-out-of-range');

  const mealTypes: MealType[] = [];
  if (!Array.isArray(input.mealTypes) || input.mealTypes.length === 0) add('mealTypes', 'missing-field');
  else {
    for (const [index, entry] of input.mealTypes.entries()) {
      const meal = MealType.safeParse(entry);
      if (!meal.success) add(`mealTypes[${index}]`, 'invalid-meal-type');
      else if (!mealTypes.includes(meal.data)) mealTypes.push(meal.data);
    }
  }

  const difficulty = typeof input.difficulty === 'string' && DIFFICULTIES.includes(input.difficulty) ? (input.difficulty as Difficulty) : null;
  if (difficulty === null) add('difficulty', 'invalid-difficulty');

  const ingredients: CheckedRecipe['ingredients'] = [];
  if (!Array.isArray(input.ingredients) || input.ingredients.length === 0) add('ingredients', 'missing-field');
  else if (input.ingredients.length > RECIPE_LIMITS.ingredients) add('ingredients', 'too-many-ingredients');
  else {
    for (const [index, line] of input.ingredients.entries()) {
      const at = `ingredients[${index}]`;
      if (!isObject(line)) {
        add(at, 'missing-field');
        continue;
      }
      const before = problems.length;
      if (typeof line.slug !== 'string' || line.slug.trim() === '') add(`${at}.slug`, 'missing-field');
      else if (line.slug.length > INGREDIENT_SLUG_MAX || !SLUG.test(line.slug)) add(`${at}.slug`, 'invalid-slug');

      const unit = Unit.safeParse(line.unit);
      if (!unit.success) add(`${at}.unit`, 'invalid-unit');

      const quantity = line.quantity;
      if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) add(`${at}.quantity`, 'invalid-quantity');
      else if (unit.success && servings !== null && quantity / servings > RECIPE_LIMITS.perServing[unit.data]) add(`${at}.quantity`, 'quantity-too-large');

      const note = plainText(line.note, RECIPE_LIMITS.note);
      if (note !== null && 'rule' in note) add(`${at}.note`, note.rule, RECIPE_LIMITS.note);

      if (problems.length === before) {
        ingredients.push({ slug: line.slug as string, quantity: quantity as number, unit: unit.data!, note: note === null ? null : (note as { text: string }).text });
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    recipe: { slug, titles, descriptions, steps, servings: servings!, mealTypes, prepMinutes: prepMinutes!, cookMinutes: cookMinutes!, difficulty: difficulty!, ingredients },
  };
}

/**
 * Check the name of an ingredient and its storage hint. `locales` are the
 * languages the draft is in: each needs a name, and what is written for any
 * other language is left out, so that nothing ships that nobody was asked to
 * approve.
 */
export function checkIngredientName(input: Record<string, unknown>, locales: readonly string[]): IngredientNameCheck {
  const { problems, add } = problemList();
  const names = isObject(input.name) ? input.name : {};
  const hints = isObject(input.storageHint) ? input.storageHint : {};

  const name: Record<string, string> = {};
  const storageHint: Record<string, string> = {};
  for (const locale of locales) {
    const text = plainText(names[locale], INGREDIENT_NAME_LIMITS.name);
    if (text === null) add(`name.${locale}`, 'missing-locale');
    else if ('rule' in text) add(`name.${locale}`, text.rule, INGREDIENT_NAME_LIMITS.name);
    else name[locale] = text.text;

    const hint = plainText(hints[locale], INGREDIENT_NAME_LIMITS.storageHint);
    if (hint === null) continue;
    if ('rule' in hint) add(`storageHint.${locale}`, hint.rule, INGREDIENT_NAME_LIMITS.storageHint);
    else storageHint[locale] = hint.text;
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, suggestion: { name, ...(Object.keys(storageHint).length > 0 ? { storageHint } : {}) } };
}
