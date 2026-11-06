// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

/**
 * A line of figures joined by dots, "Białko 136 z 134 g · tłuszcz 82 z 71 g", breaks only after a
 * dot on a narrow screen: a name keeps its figure and unit, and the dot keeps a no-break space
 * before it, so that no line starts with a lone unit, figure or dot. A longer phrase may still
 * break between its words.
 */

type Tree = { [key: string]: string | Tree };

const FOLDER = path.resolve(process.cwd(), 'messages');

function texts(tree: Tree, prefix = '', into = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') into.set(`${prefix}${key}`, value);
    else texts(value, `${prefix}${key}.`, into);
  }
  return into;
}

const read = (file: string): Tree =>
  JSON.parse(readFileSync(path.join(FOLDER, file), 'utf8')) as Tree;

/**
 * A dot with a plain space before it, which a narrow screen may put at the start of a line: in a
 * string or in the text of a tag (`{day} · {meal}`), or after a space of its own (`{' '}` · …).
 */
const LOOSE_DOT = /[^\s] ·|\{\s*['"` ]{1,3}\s*\}\s*·/;

/** The code without its comments, whose examples show a line as the eye reads it. */
const withoutComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Where a narrow screen may break a text: its pieces between plain spaces, a held space shown as one. */
const pieces = (text: string): string[] =>
  text.split(' ').map((piece) => piece.replaceAll('\u00a0', ' '));

describe('a line of figures joined by dots', () => {
  it.each(readdirSync(FOLDER).filter((file) => file.endsWith('.json')))(
    'never lets a dot of %s start a line',
    (file) => {
      const loose = [...texts(read(file))]
        .filter(([, text]) => text.includes(' ·'))
        .map(([key]) => key);
      expect(loose).toEqual([]);
    },
  );

  it('is joined in the code with the held dot, not with a plain space before it', () => {
    const SOURCE = path.resolve(process.cwd(), 'src');
    const files = readdirSync(SOURCE, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
    );
    const loose = files.filter((file) =>
      LOOSE_DOT.test(withoutComments(readFileSync(path.join(SOURCE, file), 'utf8'))),
    );
    expect(loose).toEqual([]);
  });

  it('finds a plain space before a dot in a string, in the text of a tag and after a space of its own', () => {
    expect(LOOSE_DOT.test('const line = `${day} · ${meal}`;')).toBe(true);
    expect(LOOSE_DOT.test("<p>{t('fromPlan')} · {kcal}</p>")).toBe(true);
    expect(LOOSE_DOT.test("{title}\n<span>\n  {' '}\n  · {kcal}\n</span>")).toBe(true);
    expect(LOOSE_DOT.test("<p>{t('fromPlan')}{DOT}{kcal}</p>")).toBe(false);
    expect(
      LOOSE_DOT.test(withoutComments('/** "Białko 136 z 134 g · tłuszcz" */\n// a · b\n')),
    ).toBe(false);
  });

  /** The texts of a language, said by key as the application says them. */
  type Say = (key: string, values: Record<string, string | number>) => string;
  const say = (locale: 'pl' | 'en'): Say =>
    createTranslator({ locale, messages: read(`${locale}.json`) }) as unknown as Say;

  it('breaks the average day of a plan only after a dot, while its opening words may break', () => {
    const figures = {
      protein: 136,
      proteinTarget: 134,
      fat: 82,
      fatTarget: 71,
      carbs: 250,
      carbsTarget: 249,
    };
    expect(pieces(say('pl')('mealPlans.planMacros', figures))).toEqual([
      'Dzień',
      'tego',
      'planu',
      'ma',
      'średnio:',
      'białko 136 z 134 g ·',
      'tłuszcz 82 z 71 g ·',
      'węglowodany 250 z 249 g.',
    ]);
    expect(pieces(say('en')('mealPlans.dayMacros', figures))).toEqual([
      'Protein 136 of 134 g ·',
      'fat 82 of 71 g ·',
      'carbs 250 of 249 g',
    ]);
  });

  it('keeps the letters of a diary entry with their grams', () => {
    expect(pieces(say('pl')('diary.entryMacros', { protein: 12, fat: 5, carbs: 30 }))).toEqual([
      'B 12 g ·',
      'T 5 g ·',
      'W 30 g',
    ]);
  });

  it('holds the words of a wording chosen by a count, as a part of its own', () => {
    expect(
      pieces(say('pl')('mealPlans.planSummary', { days: 7, dietType: 'Zbilansowana' })),
    ).toEqual(['Plan na 7 dni ·', 'Zbilansowana']);
    expect(
      pieces(say('pl')('recipeDetail.servingMeta', { servings: 4, prep: 15, cook: 30 })),
    ).toEqual(['Wychodzą 4 porcje ·', '15 min przygotowania ·', '30 min gotowania']);
  });
});
