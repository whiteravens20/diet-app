// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { validateRecipeTranslation } from './translation.validate.js';

const oats = {
  title: 'Overnight oats with blueberries',
  description: 'Creamy no-cook oats soaked overnight, topped with fresh blueberries.',
  steps: [
    'Combine 60 g of oats with the milk and the yogurt in a jar.',
    'Stir in the honey and refrigerate for 8 hours.',
    'Top with blueberries before serving.',
  ],
};
const polish = {
  title: 'Owsianka nocna z borówkami',
  description:
    'Kremowe płatki owsiane bez gotowania, namoczone na noc, podane ze świeżymi borówkami.',
  steps: [
    'Wymieszaj 60 g płatków z mlekiem i jogurtem w słoiku.',
    'Dodaj miód i wstaw do lodówki na 8 godzin.',
    'Przed podaniem posyp borówkami.',
  ],
};
const recipe = (answer: unknown, locale = 'pl') =>
  validateRecipeTranslation({
    source: oats,
    locale,
    rawOutput: typeof answer === 'string' ? answer : JSON.stringify(answer),
  });

describe('the text of a recipe a model translated', () => {
  it('is taken when it is the recipe in the other language: the same shape, the same steps, the same numbers', () => {
    expect(recipe(polish)).toEqual({ ok: true, text: polish });
  });

  it('is read out of a code fence and from under a line of prose', () => {
    expect(recipe(`Here you go:\n\`\`\`json\n${JSON.stringify(polish)}\n\`\`\``)).toEqual({
      ok: true,
      text: polish,
    });
  });

  it.each([
    ['no JSON at all', 'I cannot translate this.', 'malformed-json', ''],
    [
      'a key that is missing',
      { title: polish.title, steps: polish.steps },
      'missing-keys',
      'description',
    ],
    ['a key nobody asked for', { ...polish, servings: 2 }, 'extra-keys', 'servings'],
    ['a title that is no text', { ...polish, title: { pl: polish.title } }, 'not-text', 'title'],
    [
      'steps that are no list of texts',
      { ...polish, steps: [polish.steps[0], 2, polish.steps[2]] },
      'not-text',
      'steps',
    ],
    ['a step fewer', { ...polish, steps: polish.steps.slice(0, 2) }, 'step-count', 'steps'],
    ['a step more', { ...polish, steps: [...polish.steps, 'Smacznego!'] }, 'step-count', 'steps'],
    [
      'an empty step',
      { ...polish, steps: [polish.steps[0], '  ', polish.steps[2]] },
      'empty-value',
      'steps[1]',
    ],
    [
      'a number the English does not have',
      {
        ...polish,
        steps: [polish.steps[0], 'Dodaj miód i wstaw do lodówki na 12 godzin.', polish.steps[2]],
      },
      'invented-number',
      'steps[1]',
    ],
    [
      'a number in the title that came from nowhere',
      { ...polish, title: 'Owsianka nocna 300 kcal' },
      'invented-number',
      'title',
    ],
    [
      'a remark instead of a translation',
      { ...polish, description: 'Note: this dish is not known in Poland, so I kept the name.' },
      'llm-yap',
      'description',
    ],
    [
      'a description many times as long',
      { ...polish, description: polish.description.repeat(4) },
      'length-blowup',
      'description',
    ],
    [
      'a step cut down to a word',
      { ...polish, steps: ['Mieszaj.', polish.steps[1], polish.steps[2]] },
      'length-blowup',
      'steps[0]',
    ],
    [
      'a step left in English',
      { ...polish, steps: [polish.steps[0], polish.steps[1], oats.steps[2]] },
      'untranslated',
      'steps[2]',
    ],
    [
      'a description that reads as English',
      {
        ...polish,
        description: 'Creamy oats soaked for the night and served with the fresh berries.',
      },
      'untranslated',
      'description',
    ],
    ['markup', { ...polish, title: '<b>Owsianka</b> nocna z borówkami' }, 'markup', 'titles.pl'],
  ] as const)('is refused for %s', (_what, answer, reason, where) => {
    expect(recipe(answer)).toEqual({ ok: false, reason, where });
  });

  it('may carry a number from one sentence of the recipe to another, and write a decimal point as the language does', () => {
    const moved = { ...polish, description: `${polish.description} Gotowe po 8 godzinach.` };
    expect(recipe(moved).ok).toBe(true);
    const halves = validateRecipeTranslation({
      source: {
        ...oats,
        steps: ['Add 1.5 cups of milk to the oats and stir.', oats.steps[1]!, oats.steps[2]!],
      },
      locale: 'pl',
      rawOutput: JSON.stringify({
        ...polish,
        steps: [
          'Dodaj 1,5 szklanki mleka do płatków i wymieszaj.',
          polish.steps[1],
          polish.steps[2],
        ],
      }),
    });
    expect(halves.ok).toBe(true);
  });

  it('may keep a title that is the same in both languages', () => {
    const hummus = {
      title: 'Hummus',
      description: 'Chickpeas blended with tahini and lemon.',
      steps: ['Blend everything until smooth.'],
    };
    const answer = {
      title: 'Hummus',
      description: 'Ciecierzyca zmiksowana z tahini i cytryną.',
      steps: ['Zmiksuj wszystko na gładko.'],
    };

    expect(
      validateRecipeTranslation({
        source: hummus,
        locale: 'pl',
        rawOutput: JSON.stringify(answer),
      }),
    ).toEqual({ ok: true, text: answer });
  });

  it('comes back as plain text: white space is made one space', () => {
    const spaced = { ...polish, title: '  Owsianka   nocna\nz borówkami ' };

    expect(recipe(spaced)).toMatchObject({
      ok: true,
      text: { title: 'Owsianka nocna z borówkami' },
    });
  });
});
