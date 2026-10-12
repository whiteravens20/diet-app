// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPORT_ALIASES_FILE, readImportAliases } from './import-aliases.js';
import { plainName } from './slug-mapper.js';

/** A data directory that holds `content` as its file of aliases, or none. */
function directoryWith(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'diet-app-aliases-'));
  if (content !== undefined) writeFileSync(join(dir, IMPORT_ALIASES_FILE), content);
  return dir;
}
const slugs = new Set(['zucchini', 'shrimp']);

describe('the other names of the catalogue\'s ingredients', () => {
  it('are none, and nothing is wrong, where there is no file', () => {
    expect(readImportAliases(directoryWith())).toEqual({ aliases: {}, problems: [] });
  });

  it('are read as they are written', () => {
    expect(readImportAliases(directoryWith('{ "courgette": "zucchini", "prawns": "shrimp" }'), slugs)).toEqual({ aliases: { courgette: 'zucchini', prawns: 'shrimp' }, problems: [] });
  });

  it('leave out a name for an ingredient the catalogue does not have, and say so, where the catalogue is known', () => {
    const file = directoryWith('{ "courgette": "zucchini", "scallion": "spring-onion" }');

    expect(readImportAliases(file, slugs)).toEqual({ aliases: { courgette: 'zucchini' }, problems: ['"scallion": the catalogue has no ingredient "spring-onion"'] });
    // Without the catalogue to hold it against, the file is taken at its word.
    expect(readImportAliases(file).aliases).toEqual({ courgette: 'zucchini', scallion: 'spring-onion' });
  });

  it('leave out what is no slug, and say so', () => {
    expect(readImportAliases(directoryWith('{ "courgette": 7, "prawns": "", "cod": "shrimp" }'), slugs)).toEqual({
      aliases: { cod: 'shrimp' },
      problems: ['"courgette": expected the slug of an ingredient', '"prawns": expected the slug of an ingredient'],
    });
  });

  it.each([
    ['not JSON', '{ courgette: zucchini }', /^invalid JSON: /],
    ['a list', '["courgette"]', /^expected an object of names/],
    ['a text', '"zucchini"', /^expected an object of names/],
  ])('are none for a file that is %s, which is said', (_what, content, problem) => {
    const read = readImportAliases(directoryWith(content), slugs);

    expect(read.aliases).toEqual({});
    expect(read.problems).toEqual([expect.stringMatching(problem)]);
  });
});

describe('the aliases the catalogue ships with', () => {
  const shipped = resolve(__dirname, '../../../../../../data');
  const ingredients = JSON.parse(readFileSync(join(shipped, 'ingredients.json'), 'utf8')) as { slug: string; name: { en: string } }[];

  it('each name an ingredient of the curated data, and none says what the catalogue says already', () => {
    const { aliases, problems } = readImportAliases(shipped, new Set(ingredients.map((ingredient) => ingredient.slug)));

    expect(problems).toEqual([]);
    expect(Object.keys(aliases).length).toBeGreaterThan(20);
    const own = new Set(ingredients.flatMap((ingredient) => [plainName(ingredient.name.en), plainName(ingredient.slug.replaceAll('-', ' '))]));
    expect(Object.keys(aliases).filter((name) => own.has(plainName(name)))).toEqual([]);
  });

  it('are each one plain name: two spellings that come to the same do not point at two ingredients', () => {
    const { aliases } = readImportAliases(shipped);
    const byPlain = new Map<string, Set<string>>();
    for (const [name, slug] of Object.entries(aliases)) byPlain.set(plainName(name), (byPlain.get(plainName(name)) ?? new Set()).add(slug));

    expect([...byPlain].filter(([, pointsAt]) => pointsAt.size > 1)).toEqual([]);
  });
});
