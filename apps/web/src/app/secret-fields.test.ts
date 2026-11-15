// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Every secret a page asks for, a password or a key of an AI provider, is typed into a `PasswordField`: it has the
 * eye that shows what is typed and hides it again, and it never has what it holds checked for spelling. A bare
 * password input anywhere else would be a field without them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const THE_FIELD = join('components', 'ui', 'password-field.tsx');

function sources(dir: string = SRC): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [{ path: relative(SRC, full), text: readFileSync(full, 'utf8') }];
  });
}

const all = sources();

describe('the fields of secrets', () => {
  it('are all the field with the eye: no page has a password input of its own', () => {
    const bare = all
      .filter(({ path }) => path !== THE_FIELD)
      .filter(({ text }) => /\btype=(?:"password"|\{\s*['"]password['"]\s*\})/.test(text))
      .map(({ path }) => path);

    expect(bare).toEqual([]);
  });

  it('are found where the pages ask for secrets', () => {
    const fields = all.reduce(
      (count, { text }) => count + (text.match(/<PasswordField\b/g)?.length ?? 0),
      0,
    );

    expect(fields).toBeGreaterThanOrEqual(18);
  });
});
