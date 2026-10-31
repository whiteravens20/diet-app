// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';

type Tree = { [key: string]: string | Tree };

/** Every text of a language, by the path of its key. */
function texts(tree: Tree, path = '', into = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') into.set(`${path}${key}`, value);
    else texts(value, `${path}${key}.`, into);
  }
  return into;
}

/** What a text takes from the code that shows it, and how it counts. */
interface Needs {
  /** Each argument by name, with the kind it is read as: `plain` (put in as it is), `number`, `plural`, `select`, `date`… */
  arguments: Map<string, string>;
  /** The tags the code gives a meaning to: `<strong>`, `<link>`… */
  tags: Set<string>;
  /**
   * For each argument the text has several wordings for: whether it is a
   * count or a choice, the cases it words, and whether it shows the number
   * it counts (as `#`, or as an argument of its own beside the wordings).
   */
  worded: Map<string, { kind: string; cases: Set<string>; showsNumber: boolean }>;
}

const BRANCHING = new Set(['plural', 'select', 'selectordinal']);

/**
 * Read a text the way the message format does, as far as its arguments go:
 * `{name}`, `{name, number}`, and `{name, plural, one {…} other {…}}` with
 * the wordings of its cases looked into in turn.
 */
function needsOf(text: string): Needs {
  const needs: Needs = { arguments: new Map(), tags: new Set(), worded: new Map() };
  /** The counts whose wordings are being read, the innermost last. */
  const counting: string[] = [];
  const shown = new Set<string>();
  let at = 0;
  const upTo = (stop: RegExp): string => {
    const from = at;
    while (at < text.length && !stop.test(text[at]!)) at += 1;
    return text.slice(from, at).trim();
  };
  const wording = (): void => {
    while (at < text.length && text[at] !== '}') {
      if (text[at] === '{') argument();
      else if (text[at] === '<') tag();
      else {
        if (text[at] === '#' && counting.length > 0) shown.add(counting.at(-1)!);
        at += 1;
      }
    }
  };
  const tag = (): void => {
    const found = /^<\/?([a-z][a-zA-Z0-9]*)>/.exec(text.slice(at));
    if (found) needs.tags.add(found[1]!);
    at += found ? found[0].length : 1;
  };
  const argument = (): void => {
    at += 1;
    const name = upTo(/[,}]/);
    if (text[at] === '}') {
      at += 1;
      needs.arguments.set(name, needs.arguments.get(name) ?? 'plain');
      shown.add(name);
      return;
    }
    at += 1;
    const kind = upTo(/[,}]/);
    if (BRANCHING.has(kind) || !needs.arguments.has(name)) needs.arguments.set(name, kind);
    if (text[at] === '}') {
      at += 1;
      shown.add(name);
      return;
    }
    at += 1;
    if (!BRANCHING.has(kind)) {
      // A style, as in `{share, number, percent}`.
      upTo(/}/);
      at += 1;
      shown.add(name);
      return;
    }
    const cases = needs.worded.get(name)?.cases ?? new Set<string>();
    needs.worded.set(name, { kind, cases, showsNumber: false });
    counting.push(name);
    for (;;) {
      const which = upTo(/[{}]/);
      if (text[at] !== '{') break;
      cases.add(which);
      at += 1;
      wording();
      at += 1;
    }
    counting.pop();
    at += 1;
  };
  wording();
  if (at !== text.length) throw new Error(`The braces of "${text}" do not pair up.`);
  for (const [name, entry] of needs.worded) entry.showsNumber = shown.has(name);
  return needs;
}

/** Arguments that all take a number: a language may count where another only shows the number. */
const TAKES_A_NUMBER = new Set(['plain', 'number', 'plural']);

const english = texts(en as Tree);
const polish = texts(pl as Tree);

describe('the texts of the application in its two languages', () => {
  it('are the same texts: no key that one language has and the other does not', () => {
    expect(
      [...english.keys()].filter((key) => !polish.has(key)),
      'in English only',
    ).toEqual([]);
    expect(
      [...polish.keys()].filter((key) => !english.has(key)),
      'in Polish only',
    ).toEqual([]);
  });

  it('are all written: none is empty', () => {
    const empty = [...english, ...polish]
      .filter(([, text]) => text.trim() === '')
      .map(([key]) => key);

    expect(empty).toEqual([]);
  });

  it('take the same arguments and the same tags, so that what the code hands to one fits the other', () => {
    const differing: string[] = [];
    for (const [key, text] of english) {
      const other = polish.get(key);
      if (other === undefined) continue;
      const [a, b] = [needsOf(text), needsOf(other)];
      const names = (needs: Needs): string => [...needs.arguments.keys()].sort().join(', ');
      if (names(a) !== names(b))
        differing.push(`${key}: arguments {${names(a)}} in English, {${names(b)}} in Polish`);
      for (const [name, kind] of a.arguments) {
        const there = b.arguments.get(name);
        if (there === undefined || there === kind) continue;
        if (!(TAKES_A_NUMBER.has(kind) && TAKES_A_NUMBER.has(there)))
          differing.push(
            `${key}: {${name}} is read as ${kind} in English and as ${there} in Polish`,
          );
      }
      const tags = (needs: Needs): string => [...needs.tags].sort().join(', ');
      if (tags(a) !== tags(b))
        differing.push(`${key}: tags <${tags(a)}> in English, <${tags(b)}> in Polish`);
    }

    expect(differing).toEqual([]);
  });

  // Polish words a number in three ways (1 dzień, 2 dni, 5 dni, and a fourth
  // for fractions): a text that shows the number it counts needs them all. One
  // that only tells one from several ("this limit", "these limits") does not.
  it.each([
    ['English', english, ['one', 'other'], ['one', 'other']],
    ['Polish', polish, ['one', 'other'], ['one', 'few', 'many', 'other']],
  ] as const)(
    'have a wording for every case %s counts in',
    (_language, all, always, withTheNumber) => {
      const short: string[] = [];
      for (const [key, text] of all) {
        for (const [name, { kind, cases, showsNumber }] of needsOf(text).worded) {
          if (kind !== 'plural') continue;
          const missing = (showsNumber ? withTheNumber : always).filter((one) => !cases.has(one));
          if (missing.length > 0)
            short.push(`${key}: {${name}} has no wording for ${missing.join(', ')}`);
        }
      }

      expect(short).toEqual([]);
    },
  );

  // A number on its own (`{kcal, number}`) and the `#` of a count would set
  // thousands apart, each language in its own way.
  it('write every number with nothing between its thousands', () => {
    const apart = [...english, ...polish]
      .filter(([, text]) => /,\s*number\s*(?!,\s*::group-off\s*})|#/.test(text))
      .map(([key]) => key);

    expect(apart).toEqual([]);
  });

  it.each([
    ['en', '12150 kcal, 2200 days'],
    ['pl', '12150 kcal, 2200 dni'],
  ] as const)('show a number so written in %s as it stands', (locale, expected) => {
    const t = createTranslator({
      locale,
      messages: {
        written:
          '{kcal, number, ::group-off} kcal, {count, plural, one {{count, number, ::group-off} x} few {{count, number, ::group-off} x} many {{count, number, ::group-off} dni} other {{count, number, ::group-off} days}}',
      },
    });

    expect(t('written', { kcal: 12150, count: 2200 })).toBe(expected);
  });

  it('are read as the message format reads them', () => {
    const read = needsOf(
      '{count, plural, =0 {None of <strong>{name}</strong>} one {# day} other {{days, number} days}} until {date, date, short}, {role, select, ADMIN {an admin} other {a user}}',
    );

    expect(Object.fromEntries(read.arguments)).toEqual({
      count: 'plural',
      name: 'plain',
      days: 'number',
      date: 'date',
      role: 'select',
    });
    expect([...read.tags]).toEqual(['strong']);
    expect(
      Object.fromEntries(
        [...read.worded].map(([name, { kind, cases, showsNumber }]) => [
          name,
          [kind, [...cases].join(' '), showsNumber],
        ]),
      ),
    ).toEqual({
      count: ['plural', '=0 one other', true],
      role: ['select', 'ADMIN other', false],
    });
    // The number can stand beside the wordings as well as in them.
    expect(
      needsOf('{count} {count, plural, one {day} other {days}}').worded.get('count'),
    ).toMatchObject({ kind: 'plural', showsNumber: true });
    expect(
      needsOf('{count, plural, one {this limit} other {these limits}}').worded.get('count'),
    ).toMatchObject({ showsNumber: false });
    expect(needsOf('{count} {count, plural, one {day} other {days}}').arguments.get('count')).toBe(
      'plural',
    );
    expect(() => needsOf('{count, plural, one {# day}')).toThrow(/do not pair up/);
  });
});
