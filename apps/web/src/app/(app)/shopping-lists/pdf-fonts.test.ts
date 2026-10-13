// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The printed shopping list is set in the typeface the application carries
 * with it. A character the files have no glyph for is drawn in another
 * typeface, or as an empty box: so the files hold every character the
 * application itself can write on the sheet, in each of its languages.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../../../messages/en.json';
import pl from '../../../../messages/pl.json';

const FONTS = join(__dirname, '..', '..', '..', '..', 'public', 'fonts');
const DATA = join(__dirname, '..', '..', '..', '..', '..', '..', 'data');

/** Pictures of the page, which the sheet never gets. */
const NOT_PRINTED = new Set(['✨']);

/** The characters a TrueType file has a glyph for, read from its character map. */
function charactersOf(file: Buffer): Set<number> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let map = -1;
  for (let table = 0; table < view.getUint16(4); table += 1) {
    const record = 12 + table * 16;
    if (file.toString('latin1', record, record + 4) === 'cmap') map = view.getUint32(record + 8);
  }
  if (map < 0) throw new Error('the file has no character map');

  const found = new Set<number>();
  for (let subtable = 0; subtable < view.getUint16(map + 2); subtable += 1) {
    const at = map + view.getUint32(map + 4 + subtable * 8 + 4);
    const format = view.getUint16(at);
    if (format === 12) {
      // Runs of characters, each with the glyph of its first.
      for (let run = 0; run < view.getUint32(at + 12); run += 1) {
        const group = at + 16 + run * 12;
        const first = view.getUint32(group);
        for (let character = first; character <= view.getUint32(group + 4); character += 1) {
          if (view.getUint32(group + 8) + (character - first) !== 0) found.add(character);
        }
      }
    } else if (format === 4) {
      // Segments of the first 65 536 characters: a glyph by a shift, or looked up in a list.
      const segments = view.getUint16(at + 6) / 2;
      const ends = at + 14;
      const starts = ends + segments * 2 + 2;
      const shifts = starts + segments * 2;
      const lookups = shifts + segments * 2;
      for (let segment = 0; segment < segments; segment += 1) {
        const first = view.getUint16(starts + segment * 2);
        const last = Math.min(view.getUint16(ends + segment * 2), 0xfffe);
        const shift = view.getUint16(shifts + segment * 2);
        const lookup = view.getUint16(lookups + segment * 2);
        for (let character = first; character <= last; character += 1) {
          const listed = lookup === 0 ? character : view.getUint16(lookups + segment * 2 + lookup + (character - first) * 2);
          if (listed !== 0 && ((listed + shift) & 0xffff) !== 0) found.add(character);
        }
      }
    }
  }
  return found;
}

/** Every character of every text in `value`, however deep. */
function charactersIn(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === 'string') for (const character of value) into.add(character);
  else if (Array.isArray(value)) for (const entry of value) charactersIn(entry, into);
  else if (typeof value === 'object' && value !== null) for (const entry of Object.values(value)) charactersIn(entry, into);
  return into;
}

/** What the application can write on a sheet: its texts, the names of its catalogue, and what dates and numbers are written with. */
function written(): Set<string> {
  const characters = new Set<string>();
  charactersIn([en, pl], characters);
  for (const file of readdirSync(DATA).filter((name) => name.endsWith('.json'))) charactersIn(JSON.parse(readFileSync(join(DATA, file), 'utf8')), characters);
  for (const file of readdirSync(join(DATA, 'recipes')).filter((name) => name.endsWith('.json'))) charactersIn(JSON.parse(readFileSync(join(DATA, 'recipes', file), 'utf8')), characters);

  const from = new Date(Date.UTC(2026, 9, 12, 15, 4));
  for (const locale of ['en', 'en-GB', 'en-US', 'pl']) {
    charactersIn(
      [
        new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }).format(from),
        new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(from, new Date(Date.UTC(2026, 10, 3))),
        new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).formatRange(from, new Date(Date.UTC(2026, 9, 18))),
        new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(1234567.8),
        new Intl.NumberFormat(locale, { style: 'percent' }).format(0.25),
        new Intl.ListFormat(locale, { type: 'conjunction' }).format(['a', 'b', 'c']),
      ],
      characters,
    );
  }
  // What a list is written with besides: the dot between an amount and its packs, what a name or a title may well hold,
  // and the spaces one browser or another puts into a date, a time or a number.
  charactersIn('·×–—…„”“’‘→½¼¾°%&/()+\u00a0\u2009\u202f', characters);
  for (const picture of NOT_PRINTED) characters.delete(picture);
  return characters;
}

describe('the typeface of the printed shopping list', () => {
  const wanted = [...written()].filter((character) => character >= ' ');

  it.each(['Inter-Regular.ttf', 'Inter-Bold.ttf'])('%s has a glyph for every character the application writes', (name) => {
    const has = charactersOf(readFileSync(join(FONTS, name)));

    const missing = wanted.filter((character) => !has.has(character.codePointAt(0)!));

    expect(missing.map((character) => `${character} (U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`)).toEqual([]);
  });

  it('is asked of the Polish letters, the spaces of a date and the marks of a list, and not of a handful of letters alone', () => {
    expect(wanted.length).toBeGreaterThan(120);
    for (const character of ['ą', 'ę', 'ł', 'ń', 'ó', 'ś', 'ź', 'ż', 'Ł', ':', '·', '–', ' ', ' ', ' ']) expect(wanted, JSON.stringify(character)).toContain(character);
  });

  it('goes with the text of its licence', () => {
    const licence = readFileSync(join(FONTS, 'OFL.txt'), 'utf8');

    expect(licence).toContain('The Inter Project Authors');
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});
