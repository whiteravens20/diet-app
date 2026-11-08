// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loose } from '../../e2e/patterns';

const E2E = path.resolve(process.cwd(), 'e2e');

/** Every `new RegExp(…)` of a source, with what it is made of, up to its closing bracket. */
function patterns(source: string): string[] {
  const found: string[] = [];
  for (
    let at = source.indexOf('new RegExp(');
    at !== -1;
    at = source.indexOf('new RegExp(', at + 1)
  ) {
    let depth = 0;
    let end = at + 'new RegExp'.length;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    found.push(source.slice(at, end + 1));
  }
  return found;
}

/** A pattern of a link's address, which holds no text of the page. */
const ADDRESS = /^new RegExp\(\s*`\^\//;

describe('the patterns the browser tests make of a text', () => {
  it('take each space for a plain or a no-break one', () => {
    const unheld = readdirSync(E2E)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) =>
        patterns(readFileSync(path.join(E2E, file), 'utf8'))
          .filter((pattern) => !pattern.includes('loose(') && !ADDRESS.test(pattern))
          .map((pattern) => `${file}: ${pattern}`),
      );

    expect(unheld).toEqual([]);
  });

  it('match a text as a page writes it, held together or not, and nothing else', () => {
    const fromSunday = new RegExp(`^${loose('Z niedzieli (1 × 250 g)')}$`);

    expect(fromSunday.test('Z\u00a0niedzieli (1\u00a0×\u00a0250\u00a0g)')).toBe(true);
    expect(fromSunday.test('Z niedzieli (1 × 250 g)')).toBe(true);
    expect(fromSunday.test('Z niedzieli 1 × 250 g')).toBe(false);
    expect(fromSunday.test('Z  niedzieli (1 × 250 g)')).toBe(false);
  });

  it('are found where one is made without it', () => {
    const source =
      'page.getByText(new RegExp(`^${start(texts.hint)}`));\nnew RegExp(`^/plans/${id}$`);';

    expect(
      patterns(source).filter((pattern) => !pattern.includes('loose(') && !ADDRESS.test(pattern)),
    ).toEqual(['new RegExp(`^${start(texts.hint)}`)']);
  });
});
