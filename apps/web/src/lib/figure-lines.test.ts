// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { LOCALES } from '@diet-app/shared';
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

/**
 * The files of the languages the app loads (`LOCALES`): a file off that list may hold a translation
 * still being made, and is held only to what it has (`messages.test.ts`), never to how its lines break.
 */
const LISTED = LOCALES.map((locale) => `${locale}.json`);

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

/**
 * A number of a text with a plain space before the word or sign after it, which a narrow screen
 * may leave alone at the end of a line: a counted one (`#`), an argument written as a number, or
 * one written out.
 */
const LOOSE_COUNT = /(#|\{\w+, number[^{}]*\}|(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)?) (?=[\p{L}%])/u;

/** The code without its comments, whose examples show a line as the eye reads it. */
const withoutComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Where a narrow screen may break a text: its pieces between plain spaces, a held space shown as one. */
const pieces = (text: string): string[] =>
  text.split(' ').map((piece) => piece.replaceAll('\u00a0', ' '));

describe('a line of figures joined by dots', () => {
  it.each(LISTED)('never lets a dot of %s start a line', (file) => {
    const loose = [...texts(read(file))]
      .filter(([, text]) => text.includes(' ·'))
      .map(([key]) => key);
    expect(loose).toEqual([]);
  });

  it.each(LISTED)('never parts a number of %s from the word after it', (file) => {
    const loose = [...texts(read(file))]
      .filter(([, text]) => LOOSE_COUNT.test(text))
      .map(([key]) => key);
    expect(loose).toEqual([]);
  });

  /** A text with each of its arguments as one figure, as the reader sees it: `{fat, number, ::group-off}` as `0`. */
  const argued = (text: string): string => {
    let flat = text;
    while (/\{[^{}]*\}/.test(flat)) flat = flat.replace(/\{[^{}]*\}/g, '0');
    return flat;
  };

  it.each(LISTED)(
    'breaks every line of macronutrients of %s only after a dot, its opening words aside',
    (file) => {
      const loose = [...texts(read(file))]
        .filter(([key, text]) => /macros/i.test(key) && text.includes('\u00a0· '))
        .filter(([, text]) =>
          argued(text)
            .split(': ')
            .at(-1)!
            .split('\u00a0· ')
            .some((pair) => pair.includes(' ')),
        )
        .map(([key]) => key);
      expect(loose).toEqual([]);
    },
  );

  it('finds a number apart from its word, whether counted, an argument or written out', () => {
    expect(LOOSE_COUNT.test('{days, plural, one {# dnia} other {# dni}}')).toBe(true);
    expect(LOOSE_COUNT.test('W celu: {reached, number, ::group-off} z 7 dni')).toBe(true);
    expect(LOOSE_COUNT.test('Co najmniej 12 znaków')).toBe(true);
    expect(LOOSE_COUNT.test('Cel: 1,5 l')).toBe(true);
    expect(LOOSE_COUNT.test('Co najmniej 12\u00a0znaków, {n, number}\u00a0dni, 7 · 8')).toBe(false);
    expect(LOOSE_COUNT.test('Krok2 i x1 z {name}')).toBe(false);
  });

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

  it('keeps a count with its days, and a word of one letter with what follows it, in the lines of the week and of the water', () => {
    const week = { average: '1,67 l', target: '2 l', reached: 3, counted: 6 };
    expect(pieces(say('pl')('weekSummary.water', week)).slice(-2)).toEqual([
      'w celu',
      '3 z 6 dni.',
    ]);
    expect(pieces(say('pl')('weekSummary.within', { within: 0, counted: 7 })).slice(-1)).toEqual([
      '0 z 7 dni',
    ]);
    expect(pieces(say('pl')('water.inTarget', { reached: 3, days: 7 })).slice(-1)).toEqual([
      '3 z 7 dni',
    ]);
    expect(pieces(say('en')('water.inTarget', { reached: 1, days: 1 })).slice(-1)).toEqual([
      '1 day',
    ]);
  });

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

/** The units and counted words that follow a value put in as text. */
const UNIT = String.raw`(?:g|kg|mg|µg|kcal|ml|l|lb|cm|min|h|dni|dnia|dzień|days?|servings?)`;

/** A value put in as text, `{kcal} kcal`, with a plain space before its unit: a narrow screen may leave the number at a line's end. */
const LOOSE_UNIT = new RegExp(String.raw`\{\w+\} ${UNIT}(?=[\s.,;:)!?\u00a0]|$)`, 'u');

/** The number formats of the application, whose figure a unit follows. */
const FORMATTED = String.raw`\$\{(?:fmt\.(?:number|fixed|signed|unit|percent)|Math\.round)\([^{}]*\)\}`;

/** A figure the code joins to its unit with a plain space: a number formatted, then a unit written or put in. */
const LOOSE_FIGURE = new RegExp(
  [
    String.raw`${FORMATTED} ${UNIT}(?![\p{L}\p{N}])`,
    String.raw`${FORMATTED} \$\{`,
    String.raw`\{\w+\} \{(?:unit|kcal)\w*\}`,
  ].join('|'),
  'u',
);

/** The application's sources, comments left out, by their path under `src`. */
const sources = (): [string, string][] => {
  const SOURCE = path.resolve(process.cwd(), 'src');
  return readdirSync(SOURCE, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => [file, withoutComments(readFileSync(path.join(SOURCE, file), 'utf8'))]);
};

describe('a value put in and its unit', () => {
  it.each(LISTED)('are held together in every text of %s', (file) => {
    const loose = [...texts(read(file))]
      .filter(([, text]) => LOOSE_UNIT.test(text))
      .map(([key]) => key);
    expect(loose).toEqual([]);
  });

  it('are found apart in a text', () => {
    expect(LOOSE_UNIT.test('Cel dnia: {kcal} kcal.')).toBe(true);
    expect(LOOSE_UNIT.test('Własna ({protein} g białka)')).toBe(true);
    expect(LOOSE_UNIT.test('Cel dnia: {kcal}\u00a0kcal, {name} gotuje.')).toBe(false);
  });

  it('are held together in the code', () => {
    const loose = sources()
      .filter(([, code]) => LOOSE_FIGURE.test(code))
      .map(([file]) => file);
    expect(loose).toEqual([]);
  });

  it('are found apart in the code', () => {
    expect(LOOSE_FIGURE.test('value={`${fmt.number(kcal)} kcal`}')).toBe(true);
    expect(LOOSE_FIGURE.test('`${fmt.number(value, 2)} ${unit}`')).toBe(true);
    expect(LOOSE_FIGURE.test('<span>{value} {unit}</span>')).toBe(true);
    expect(LOOSE_FIGURE.test('`${fmt.number(kcal)}\\u00a0kcal`')).toBe(false);
    expect(LOOSE_FIGURE.test('`${fmt.weekday(date)} ${mealName(meal)}`')).toBe(false);
    expect(LOOSE_FIGURE.test('`${count} grams of ${name}`')).toBe(false);
    expect(LOOSE_FIGURE.test('d={`M ${x - 5} ${y - 4} l 3.5 3.5`}')).toBe(false);
  });
});

/**
 * A per cent sign with any space before it, plain or no-break: the application writes it right after
 * its number in every language, as the number formats do ("42%").
 */
const SPACED_PERCENT = /(?:\{[^{}]+\}|#|\d)[ \u00a0]%/u;

/** The same in the code: a number formatted, or put in, then a space and the sign. */
const SPACED_PERCENT_CODE = /(?:\$\{[^{}]+\}|\{\w+\})(?: |\\u00a0|\u00a0)%/u;

describe('a per cent sign', () => {
  it.each(LISTED)('stands right after its number in every text of %s', (file) => {
    const spaced = [...texts(read(file))]
      .filter(([, text]) => SPACED_PERCENT.test(text))
      .map(([key]) => key);
    expect(spaced).toEqual([]);
  });

  it('is found apart from its number in a text, whatever the space', () => {
    expect(SPACED_PERCENT.test('Własna ({protein} % białka)')).toBe(true);
    expect(SPACED_PERCENT.test('zużywa ok.\u00a0{share}\u00a0% zapasów')).toBe(true);
    expect(SPACED_PERCENT.test('sumować się do 100 %.')).toBe(true);
    expect(SPACED_PERCENT.test('Własna ({protein}% białka), 100% dnia')).toBe(false);
  });

  it('stands right after its number in the code', () => {
    const spaced = sources()
      .filter(([, code]) => SPACED_PERCENT_CODE.test(code))
      .map(([file]) => file);
    expect(spaced).toEqual([]);
  });

  it('is found apart from its number in the code', () => {
    expect(SPACED_PERCENT_CODE.test('`${fmt.number(share)} %`')).toBe(true);
    expect(SPACED_PERCENT_CODE.test('`${value}\\u00a0%`')).toBe(true);
    expect(SPACED_PERCENT_CODE.test('style={{ width: `${pct ?? 0}%` }}')).toBe(false);
  });
});

/** A sign that ends a sentence with a plain space before it: a narrow screen may begin a line with it alone. */
const LOOSE_SIGN = /(?<=\S) [≈≥≤](?=[.,;:!?)]|$)/u;

describe('a sign that ends a sentence', () => {
  it.each(LISTED)('is held to the word before it in every text of %s', (file) => {
    const loose = [...texts(read(file))]
      .filter(([, text]) => LOOSE_SIGN.test(text))
      .map(([key]) => key);
    expect(loose).toEqual([]);
  });

  it('is found alone', () => {
    expect(LOOSE_SIGN.test('Dziennik oszacuje i oznaczy ≈.')).toBe(true);
    expect(LOOSE_SIGN.test('Dziennik oznaczy\u00a0≈. Suma ≥ 12 g')).toBe(false);
  });
});

/** A Polish word of one letter with a plain space after it: a narrow screen may leave it alone at a line's end. */
const LOOSE_LETTER = /(?:^|[\s(„"»<>{])[wziaouWZIAOU] (?=\S)/u;

describe('a Polish word of one letter', () => {
  it('is held to the word after it in every Polish text', () => {
    const loose = [...texts(read('pl.json'))]
      .filter(([, text]) => LOOSE_LETTER.test(text))
      .map(([key]) => key);
    expect(loose).toEqual([]);
  });

  it('is found alone', () => {
    expect(LOOSE_LETTER.test('Wyłączysz ją w profilu.')).toBe(true);
    expect(LOOSE_LETTER.test('W tym przepisie')).toBe(true);
    expect(LOOSE_LETTER.test('{count, plural, one {i {count} szkic}}')).toBe(true);
    expect(LOOSE_LETTER.test('Wyłączysz ją w\u00a0profilu i\u00a0tyle, B 12 g')).toBe(false);
  });
});

/** The sign of a number written by hand with a hyphen, where the minus sign belongs. */
const HYPHEN_SIGN = /\? *'-' *:|: *'-'(?!-)|['"`]-\$\{|'-' *\+ *[\w(]/;

describe('the sign of a number', () => {
  it('is written by the formats, never with a hyphen by hand', () => {
    const loose = sources()
      .filter(([, code]) => HYPHEN_SIGN.test(code))
      .map(([file]) => file);
    expect(loose).toEqual([]);
  });

  it('is found written by hand with a hyphen', () => {
    expect(HYPHEN_SIGN.test("`${delta < 0 ? '-' : '+'}${Math.abs(delta)}`")).toBe(true);
    expect(HYPHEN_SIGN.test('`-${Math.abs(delta)}`')).toBe(true);
    expect(HYPHEN_SIGN.test("'-' + Math.abs(delta)")).toBe(true);
    expect(HYPHEN_SIGN.test("`${delta < 0 ? '−' : '+'}${Math.abs(delta)}`")).toBe(false);
    expect(HYPHEN_SIGN.test("className={cn('-mx-2', '--x')}")).toBe(false);
  });
});
