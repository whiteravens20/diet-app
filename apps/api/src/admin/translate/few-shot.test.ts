/**
 * Lock the curated PL few-shot corpus at ≥ 80 entries so we don't silently
 * drop terminology anchors. Adding new pairs is welcome; removing them needs
 * a deliberate test bump.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FEW_SHOT_DIR = join(__dirname, 'few-shot');

interface FewShotPair {
  source: string;
  translation: string;
}

function load(locale: string): FewShotPair[] {
  return JSON.parse(readFileSync(join(FEW_SHOT_DIR, `${locale}.json`), 'utf8'));
}

describe('translate few-shot corpus — pl', () => {
  const pairs = load('pl');

  it('parses as JSON', () => {
    expect(Array.isArray(pairs)).toBe(true);
  });

  it('has at least 80 anchor pairs', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(80);
  });

  it('every pair has non-empty source and translation strings', () => {
    for (const p of pairs) {
      expect(typeof p.source).toBe('string');
      expect(typeof p.translation).toBe('string');
      expect(p.source.trim().length).toBeGreaterThan(0);
      expect(p.translation.trim().length).toBeGreaterThan(0);
    }
  });

  it('translations are not identical to source (would defeat the anchor)', () => {
    for (const p of pairs) {
      expect(p.translation).not.toBe(p.source);
    }
  });
});
