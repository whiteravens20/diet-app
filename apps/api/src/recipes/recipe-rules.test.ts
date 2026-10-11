// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { RECIPE_LIMITS } from '@diet-app/shared';
import { checkIngredientName, checkRecipe, checkRecipeText, type RecipeProblem } from './recipe-rules.js';

/** A recipe every rule lets through, in two languages. */
const recipe = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: 'oat-bowl',
  titles: { en: 'Oat bowl', pl: 'Owsianka' },
  descriptions: { en: 'Oats with milk and a banana.', pl: 'Płatki z mlekiem i bananem.' },
  steps: { en: ['Warm the milk.', 'Stir in the oats.'], pl: ['Podgrzej mleko.', 'Wmieszaj płatki.'] },
  servings: 2,
  mealTypes: ['breakfast'],
  prepMinutes: 5,
  cookMinutes: 10,
  difficulty: 'easy',
  ingredients: [
    { slug: 'rolled-oats', quantity: 120, unit: 'g' },
    { slug: 'whole-milk', quantity: 400, unit: 'ml', note: 'warm' },
    { slug: 'banana', quantity: 2, unit: 'piece' },
  ],
  ...over,
});

const LOCALES = ['en', 'pl'];
const problemsOf = (input: Record<string, unknown>, locales: string[] = LOCALES): RecipeProblem[] => {
  const result = checkRecipe(input, locales);
  return result.ok ? [] : result.problems;
};
const rulesOf = (input: Record<string, unknown>, locales?: string[]): string[] => problemsOf(input, locales).map((p) => `${p.path}: ${p.rule}`);

describe('what a recipe may hold', () => {
  it('lets a plain recipe through, as it was written', () => {
    const result = checkRecipe(recipe(), LOCALES);

    expect(result).toEqual({
      ok: true,
      recipe: {
        slug: 'oat-bowl',
        titles: { en: 'Oat bowl', pl: 'Owsianka' },
        descriptions: { en: 'Oats with milk and a banana.', pl: 'Płatki z mlekiem i bananem.' },
        steps: { en: ['Warm the milk.', 'Stir in the oats.'], pl: ['Podgrzej mleko.', 'Wmieszaj płatki.'] },
        servings: 2,
        mealTypes: ['breakfast'],
        prepMinutes: 5,
        cookMinutes: 10,
        difficulty: 'easy',
        ingredients: [
          { slug: 'rolled-oats', quantity: 120, unit: 'g', note: null },
          { slug: 'whole-milk', quantity: 400, unit: 'ml', note: 'warm' },
          { slug: 'banana', quantity: 2, unit: 'piece', note: null },
        ],
      },
    });
  });

  describe('its text', () => {
    it('is one plain line: line breaks, tabs and runs of spaces become one space', () => {
      const result = checkRecipe(recipe({ titles: { en: '  Oat\n\tbowl ', pl: 'Owsianka' }, steps: { en: ['Warm\r\nthe   milk.', 'Stir.'], pl: ['Podgrzej.', 'Wmieszaj.'] } }), LOCALES);

      expect(result.ok && result.recipe.titles.en).toBe('Oat bowl');
      expect(result.ok && result.recipe.steps.en).toEqual(['Warm the milk.', 'Stir.']);
    });

    it('loses the control characters and the byte-order mark a model may leave in it', () => {
      const result = checkRecipe(recipe({ titles: { en: '\ufeffOat\u0000 bowl\u0007', pl: 'Owsianka' } }), LOCALES);

      expect(result.ok && result.recipe.titles.en).toBe('Oat bowl');
    });

    it.each([
      ['a tag', 'Dish <img src=x onerror=alert(1)>'],
      ['a closing tag', 'Dish </b>'],
      ['a lone angle bracket', 'Bake until > 75 degrees'],
      ['a zero-width space', 'Oat\u200bbowl'],
      ['a direction override', 'Oat \u202ebowl'],
    ])('may not hold %s', (_what, text) => {
      expect(rulesOf(recipe({ titles: { en: text, pl: 'Owsianka' } }))).toEqual(['titles.en: markup']);
      expect(rulesOf(recipe({ descriptions: { en: 'Fine.', pl: text } }))).toEqual(['descriptions.pl: markup']);
      expect(rulesOf(recipe({ steps: { en: ['Fine.', text], pl: ['Dobrze.'] } }))).toEqual(['steps.en[1]: markup']);
      expect(rulesOf(recipe({ ingredients: [{ slug: 'rolled-oats', quantity: 50, unit: 'g', note: text }] }))).toEqual(['ingredients[0].note: markup']);
    });

    it('has a length for each kind, and a text at the limit passes', () => {
      const of = (n: number) => 'a'.repeat(n);
      const atLimit = recipe({
        titles: { en: of(RECIPE_LIMITS.title), pl: 'Owsianka' },
        descriptions: { en: of(RECIPE_LIMITS.description), pl: 'Opis.' },
        steps: { en: [of(RECIPE_LIMITS.step)], pl: ['Krok.'] },
        ingredients: [{ slug: 'rolled-oats', quantity: 50, unit: 'g', note: of(RECIPE_LIMITS.note) }],
      });
      expect(rulesOf(atLimit)).toEqual([]);

      const over = recipe({
        titles: { en: of(RECIPE_LIMITS.title + 1), pl: 'Owsianka' },
        descriptions: { en: of(2_000_000), pl: 'Opis.' },
        steps: { en: [of(RECIPE_LIMITS.step + 1)], pl: ['Krok.'] },
        ingredients: [{ slug: 'rolled-oats', quantity: 50, unit: 'g', note: of(RECIPE_LIMITS.note + 1) }],
      });
      expect(rulesOf(over)).toEqual(['titles.en: text-too-long', 'descriptions.en: text-too-long', 'steps.en[0]: text-too-long', 'ingredients[0].note: text-too-long']);
    });

    it('is there for every language of the recipe', () => {
      expect(rulesOf(recipe({ titles: { en: 'Oat bowl' } }))).toEqual(['titles.pl: missing-locale']);
      expect(rulesOf(recipe({ descriptions: { en: 'Oats.', pl: '   ' } }))).toEqual(['descriptions.pl: missing-locale']);
      expect(rulesOf(recipe({ steps: { en: ['Warm.'], pl: [] } }))).toEqual(['steps.pl: missing-locale']);
      expect(rulesOf(recipe({ steps: 'Warm the milk.' }))).toEqual(['steps.en: missing-locale', 'steps.pl: missing-locale']);
    });

    it('is kept for the languages of the recipe only', () => {
      const result = checkRecipe(recipe({ titles: { en: 'Oat bowl', pl: 'Owsianka', de: 'Haferbrei' } }), ['en']);

      expect(result.ok && result.recipe.titles).toEqual({ en: 'Oat bowl' });
      expect(result.ok && result.recipe.steps).toEqual({ en: ['Warm the milk.', 'Stir in the oats.'] });
    });

    it('drops a step with nothing in it, and wants at least one that is left', () => {
      const result = checkRecipe(recipe({ steps: { en: ['Warm the milk.', '  ', ''], pl: ['Podgrzej.'] } }), LOCALES);
      expect(result.ok && result.recipe.steps.en).toEqual(['Warm the milk.']);

      expect(rulesOf(recipe({ steps: { en: ['', ' '], pl: ['Podgrzej.'] } }))).toEqual(['steps.en: missing-locale']);
    });

    it('has no more steps than a recipe card holds', () => {
      const many = Array.from({ length: RECIPE_LIMITS.steps + 1 }, (_, i) => `Step ${i + 1}.`);

      expect(rulesOf(recipe({ steps: { en: many, pl: ['Krok.'] } }))).toEqual(['steps.en: too-many-steps']);
      expect(rulesOf(recipe({ steps: { en: many.slice(1), pl: ['Krok.'] } }))).toEqual([]);
    });
  });

  describe('its ingredients', () => {
    const lines = (...list: unknown[]) => recipe({ ingredients: list });

    it('are at least one and no more than a recipe card holds', () => {
      expect(rulesOf(lines())).toEqual(['ingredients: missing-field']);
      expect(rulesOf(recipe({ ingredients: 'oats' }))).toEqual(['ingredients: missing-field']);
      const many = Array.from({ length: RECIPE_LIMITS.ingredients + 1 }, (_, i) => ({ slug: `ingredient-${i}`, quantity: 10, unit: 'g' }));
      expect(rulesOf(recipe({ ingredients: many }))).toEqual(['ingredients: too-many-ingredients']);
      expect(rulesOf(recipe({ ingredients: many.slice(1) }))).toEqual([]);
    });

    it('each name an ingredient by its slug, in a unit the catalogue has', () => {
      expect(rulesOf(lines({ quantity: 50, unit: 'g' }))).toEqual(['ingredients[0].slug: missing-field']);
      expect(rulesOf(lines({ slug: 'Rolled Oats!', quantity: 50, unit: 'g' }))).toEqual(['ingredients[0].slug: invalid-slug']);
      // A name from the food database can be a long sentence.
      expect(rulesOf(lines({ slug: 'beef-chuck-under-blade-pot-roast-or-steak-boneless-separable-lean-and-fat-trimmed-to-0-fat-all-grades-cooked-braised', quantity: 50, unit: 'g' }))).toEqual([]);
      expect(rulesOf(lines({ slug: 'rolled-oats', quantity: 50, unit: 'cup' }))).toEqual(['ingredients[0].unit: invalid-unit']);
      expect(rulesOf(lines('rolled-oats'))).toEqual(['ingredients[0]: missing-field']);
    });

    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, '50', null])('have a quantity that is a positive number, not %s', (quantity) => {
      expect(rulesOf(lines({ slug: 'rolled-oats', quantity, unit: 'g' }))).toEqual(['ingredients[0].quantity: invalid-quantity']);
    });

    it('have a ceiling for one serving: ten kilograms of oats for two is not a recipe', () => {
      expect(rulesOf(lines({ slug: 'rolled-oats', quantity: 10_000, unit: 'g' }))).toEqual(['ingredients[0].quantity: quantity-too-large']);
      // The same line for more people is another matter.
      const perServing = RECIPE_LIMITS.perServing;
      expect(rulesOf(recipe({ servings: 4, ingredients: [{ slug: 'potato', quantity: perServing.g * 4, unit: 'g' }] }))).toEqual([]);
      expect(rulesOf(recipe({ servings: 4, ingredients: [{ slug: 'potato', quantity: perServing.g * 4 + 1, unit: 'g' }] }))).toEqual(['ingredients[0].quantity: quantity-too-large']);
      expect(rulesOf(recipe({ servings: 1, ingredients: [{ slug: 'egg', quantity: perServing.piece + 1, unit: 'piece' }] }))).toEqual(['ingredients[0].quantity: quantity-too-large']);
      expect(rulesOf(recipe({ servings: 1, ingredients: [{ slug: 'stock', quantity: perServing.ml, unit: 'ml' }] }))).toEqual([]);
    });

    it('lose a note with nothing in it', () => {
      const result = checkRecipe(lines({ slug: 'rolled-oats', quantity: 50, unit: 'g', note: '  ' }), LOCALES);

      expect(result.ok && result.recipe.ingredients[0]!.note).toBeNull();
    });
  });

  describe('its numbers and labels', () => {
    it.each([0, -1, 1.5, RECIPE_LIMITS.servings + 1, 500, '2', undefined])('has servings that are a whole number up to twelve, not %s', (servings) => {
      expect(rulesOf(recipe({ servings }))).toEqual([servings === undefined ? 'servings: missing-field' : 'servings: servings-out-of-range']);
    });

    it('has times that are whole minutes within a working day', () => {
      expect(rulesOf(recipe({ prepMinutes: -1 }))).toEqual(['prepMinutes: time-out-of-range']);
      expect(rulesOf(recipe({ cookMinutes: RECIPE_LIMITS.minutes + 1 }))).toEqual(['cookMinutes: time-out-of-range']);
      expect(rulesOf(recipe({ cookMinutes: 12.5 }))).toEqual(['cookMinutes: time-out-of-range']);
      expect(rulesOf(recipe({ prepMinutes: 0, cookMinutes: RECIPE_LIMITS.minutes }))).toEqual([]);
      expect(rulesOf(recipe({ prepMinutes: undefined }))).toEqual(['prepMinutes: missing-field']);
    });

    it('is for meals the planner knows, at least one, each once', () => {
      expect(rulesOf(recipe({ mealTypes: [] }))).toEqual(['mealTypes: missing-field']);
      expect(rulesOf(recipe({ mealTypes: ['brunch'] }))).toEqual(['mealTypes[0]: invalid-meal-type']);
      const result = checkRecipe(recipe({ mealTypes: ['lunch', 'dinner', 'lunch'] }), LOCALES);
      expect(result.ok && result.recipe.mealTypes).toEqual(['lunch', 'dinner']);
    });

    it('has one of the three difficulties', () => {
      expect(rulesOf(recipe({ difficulty: 'trivial' }))).toEqual(['difficulty: invalid-difficulty']);
      expect(rulesOf(recipe({ difficulty: undefined }))).toEqual(['difficulty: invalid-difficulty']);
    });

    it('has a slug of lower-case words joined by hyphens when it has one at all', () => {
      expect(rulesOf(recipe({ slug: 'Oat Bowl' }))).toEqual(['slug: invalid-slug']);
      expect(rulesOf(recipe({ slug: 'a'.repeat(RECIPE_LIMITS.slug + 1) }))).toEqual(['slug: invalid-slug']);
      expect(rulesOf(recipe({ slug: '../etc/passwd' }))).toEqual(['slug: invalid-slug']);
      // A recipe a user asks a model for has no slug.
      const result = checkRecipe(recipe({ slug: undefined }), LOCALES);
      expect(result.ok && result.recipe.slug).toBeNull();
    });
  });

  it('names every problem at once, so that an editor can show them all', () => {
    const rules = rulesOf(recipe({ titles: { en: '<b>Bowl</b>', pl: 'Owsianka' }, servings: 500, ingredients: [{ slug: 'rolled-oats', quantity: -1, unit: 'g' }] }));

    expect(rules).toEqual(['titles.en: markup', 'servings: servings-out-of-range', 'ingredients[0].quantity: invalid-quantity']);
  });

  it('says in a sentence what is wrong', () => {
    const [problem] = problemsOf(recipe({ titles: { en: 'a'.repeat(200), pl: 'Owsianka' } }));

    expect(problem).toEqual({ path: 'titles.en', rule: 'text-too-long', message: `titles.en is longer than ${RECIPE_LIMITS.title} characters` });
  });
});

describe('the text of one language of a recipe', () => {
  it('is checked on its own, whatever else the recipe holds', () => {
    // Somebody who edits Polish is not answerable for the servings or for the English.
    const result = checkRecipeText({ titles: { en: '<b>Bowl</b>', pl: ' Owsianka ' }, descriptions: { pl: 'Płatki.' }, steps: { pl: ['Wymieszaj.', ''] }, servings: 500 }, ['pl']);

    expect(result).toEqual({ ok: true, text: { titles: { pl: 'Owsianka' }, descriptions: { pl: 'Płatki.' }, steps: { pl: ['Wymieszaj.'] } } });
  });

  it('names what is wrong with it', () => {
    const result = checkRecipeText({ titles: { pl: 'a'.repeat(121) }, descriptions: {}, steps: { pl: ['<svg>'] } }, ['pl']);

    expect(result.ok ? [] : result.problems.map((p) => `${p.path}: ${p.rule}`)).toEqual(['titles.pl: text-too-long', 'descriptions.pl: missing-locale', 'steps.pl[0]: markup']);
  });
});

describe('what the name of an ingredient may hold', () => {
  it('is a name for every language of the draft, with a storage hint where there is one', () => {
    expect(checkIngredientName({ name: { pl: ' Polędwica  wołowa ' }, storageHint: { pl: 'W lodówce.' } }, ['pl'])).toEqual({
      ok: true,
      suggestion: { name: { pl: 'Polędwica wołowa' }, storageHint: { pl: 'W lodówce.' } },
    });
  });

  it('keeps nothing for a language the draft is not in', () => {
    // An English name on a draft made for Polish would ship without anybody having approved it.
    const result = checkIngredientName({ name: { pl: 'Polędwica', en: 'Tenderloin' }, storageHint: { en: 'Chilled.' } }, ['pl']);

    expect(result).toEqual({ ok: true, suggestion: { name: { pl: 'Polędwica' } } });
  });

  it('wants the name in every language of the draft, plain and of a length', () => {
    const rules = (input: Record<string, unknown>) => {
      const result = checkIngredientName(input, ['pl']);
      return result.ok ? [] : result.problems.map((p) => `${p.path}: ${p.rule}`);
    };

    expect(rules({ name: {} })).toEqual(['name.pl: missing-locale']);
    expect(rules({ name: 'Polędwica' })).toEqual(['name.pl: missing-locale']);
    expect(rules({ name: { pl: '<i>Polędwica</i>' } })).toEqual(['name.pl: markup']);
    expect(rules({ name: { pl: 'a'.repeat(121) } })).toEqual(['name.pl: text-too-long']);
    expect(rules({ name: { pl: 'Polędwica' }, storageHint: { pl: 'a'.repeat(301) } })).toEqual(['storageHint.pl: text-too-long']);
    expect(rules({ name: { pl: 'Polędwica' }, storageHint: { pl: 'Keep <cold>' } })).toEqual(['storageHint.pl: markup']);
  });

  it('drops a storage hint with nothing in it', () => {
    expect(checkIngredientName({ name: { pl: 'Polędwica' }, storageHint: { pl: '  ' } }, ['pl'])).toEqual({ ok: true, suggestion: { name: { pl: 'Polędwica' } } });
  });
});
