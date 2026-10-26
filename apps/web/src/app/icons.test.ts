// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The icons of the application are one family, and each is called by one
 * name. The library keeps the names an icon had before as aliases of the one
 * it has now; two names for one icon in the sources make two icons of one for
 * whoever reads them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const FAMILY = 'lucide-react';
/** Where the family keeps one file for every name. */
const ICONS = join(dirname(createRequire(__filename).resolve(FAMILY)), '..', 'esm', 'icons');

function sources(dir: string = SRC): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [{ path: relative(SRC, full), text: readFileSync(full, 'utf8') }];
  });
}

/** `TriangleAlert` as the family names its file: `triangle-alert`. */
const fileOf = (name: string): string =>
  name
    .replace(/([a-z])([A-Z0-9])/g, '$1-$2')
    .replace(/([0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();

const all = sources();
/** Every icon a source takes from the family, with the source that takes it. */
const taken = all.flatMap(({ path, text }) =>
  [...text.matchAll(/import \{([^}]+)\} from 'lucide-react';/g)]
    .flatMap((found) => found[1]!.split(','))
    .map((name) => name.trim())
    .filter((name) => name !== '' && !name.startsWith('type '))
    .map((name) => ({ path, name: name.split(' as ')[0]!.trim() })),
);

describe('the icons of the application', () => {
  it('come from one family', () => {
    const others = all.flatMap(({ path, text }) =>
      [
        ...text.matchAll(
          /from '((?:react-icons|@heroicons|@tabler\/icons|@phosphor-icons|@radix-ui\/react-icons|@fortawesome)[^']*)'/g,
        ),
      ].map((found) => `${path}: ${found[1]}`),
    );

    expect(others).toEqual([]);
    expect(taken.length).toBeGreaterThan(40);
  });

  it('are each called by the one name the family has for them now', () => {
    const aliases = taken.flatMap(({ path, name }) => {
      const file = join(ICONS, `${fileOf(name)}.mjs`);
      if (!existsSync(file)) return [`${path}: ${name} is no icon of the family`];
      const now = /export \{ default \} from '\.\/([a-z0-9-]+)\.mjs'/.exec(
        readFileSync(file, 'utf8'),
      );
      return now ? [`${path}: ${name} is ${now[1]} by an earlier name`] : [];
    });

    expect(aliases).toEqual([]);
  });
});
