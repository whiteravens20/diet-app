import { describe, expect, it } from 'vitest';
import {
  rewriteSwapModeA,
  rewriteSwapModeB,
  substituteCaseAware,
  validateModeBOutput,
} from './swap-rewrite.js';
import type { Locale } from '@diet-app/shared';

describe('substituteCaseAware', () => {
  it('replaces every occurrence in one pass', () => {
    expect(substituteCaseAware('chicken and chicken', 'chicken', 'tofu')).toBe(
      'tofu and tofu',
    );
  });

  it('preserves capitalisation of the matched fragment', () => {
    expect(substituteCaseAware('Chicken with chicken', 'chicken', 'tofu')).toBe(
      'Tofu with tofu',
    );
  });

  it('escapes regex metacharacters in the source name', () => {
    // Without escaping, the `.` in `cottage.cheese` would match any char and
    // produce false positives. Word-boundary matching keeps the substitution
    // exact otherwise.
    expect(
      substituteCaseAware('cottage.cheese tastes mild', 'cottage.cheese', 'feta'),
    ).toBe('feta tastes mild');
  });

  it('returns the input unchanged when oldName is empty', () => {
    expect(substituteCaseAware('hello', '', 'world')).toBe('hello');
  });
});

describe('rewriteSwapModeA', () => {
  const en: Locale = 'en';
  const pl: Locale = 'pl';

  it('substitutes per locale and rewrites the title via the template', () => {
    const out = rewriteSwapModeA({
      source: new Map([
        [
          en,
          {
            title: 'Chicken curry',
            description: 'A spicy chicken curry.',
            steps: ['Sear the chicken.', 'Add coconut milk.'],
          },
        ],
        [
          pl,
          {
            title: 'Curry z kurczaka',
            description: 'Pikantne curry z kurczakiem.',
            steps: ['Obsmaż kurczaka.', 'Dodaj mleko kokosowe.'],
          },
        ],
      ]),
      oldName: new Map([
        [en, 'chicken'],
        // Bare nominative form. The two-pass substituter falls back to
        // suffix-tolerant matching when the strict pass finds nothing, so
        // "kurczakiem" / "kurczaka" both swap in — the inflected suffix is
        // dropped. Mode B is still the proper grammatical fix, but Mode A
        // now consistently reaches the description and steps.
        [pl, 'kurczak'],
      ]),
      newName: new Map([
        [en, 'tofu'],
        [pl, 'tofu'],
      ]),
    });

    expect(out.get(en)).toEqual({
      title: 'Chicken curry (with tofu)',
      description: 'A spicy tofu curry.',
      steps: ['Sear the tofu.', 'Add coconut milk.'],
    });
    // PL: title from the locale template, inflected forms ("kurczakiem",
    // "kurczaka") collapse to the bare new ingredient name — readable, no
    // longer leaves stale references in the prose.
    expect(out.get(pl)).toEqual({
      title: 'Curry z kurczaka (z tofu)',
      description: 'Pikantne curry z tofu.',
      steps: ['Obsmaż tofu.', 'Dodaj mleko kokosowe.'],
    });
  });

  it('keeps strict word-boundary behaviour when the strict pass already matches', () => {
    // Mixed form: one bare nominative + one inflected. The strict pass finds
    // the bare form and runs, so the inflected form stays untouched — we
    // never escalate to the suffix-tolerant pass when the strict one had
    // matches. Honest about the limitation rather than over-applying.
    const out = rewriteSwapModeA({
      source: new Map([
        [
          pl,
          {
            title: 'Curry z kurczaka',
            description: 'Kurczak i kurczakiem.',
            steps: ['Krok 1.'],
          },
        ],
      ]),
      oldName: new Map([[pl, 'kurczak']]),
      newName: new Map([[pl, 'tofu']]),
    });
    expect(out.get(pl)?.description).toBe('Tofu i kurczakiem.');
  });

  it('does not stem-match short ingredient names like "egg"', () => {
    // Strict pass finds nothing in "eggplant slices". The length guard
    // (oldName.length < 4) skips the suffix pass, so we don't accidentally
    // swap "eggplant" → "tofu".
    expect(substituteCaseAware('eggplant slices', 'egg', 'tofu')).toBe('eggplant slices');
  });

  it('falls back to title-template when one locale lacks a translation', () => {
    const out = rewriteSwapModeA({
      source: new Map([
        [
          en,
          {
            title: 'Chicken curry',
            description: 'A spicy chicken curry.',
            steps: ['Sear the chicken.'],
          },
        ],
      ]),
      oldName: new Map([[en, 'chicken']]),
      newName: new Map([
        [en, 'tofu'],
        [pl, 'tofu'],
      ]),
    });
    expect(out.size).toBe(1);
    expect(out.get(en)?.title).toBe('Chicken curry (with tofu)');
  });
});

describe('validateModeBOutput', () => {
  const source = {
    description: 'A spicy chicken curry with 200g of chicken.',
    steps: ['Sear the chicken.', 'Add 250ml coconut milk.', 'Simmer 15 minutes.'],
    oldName: 'chicken',
    newName: 'tofu',
  };

  it('accepts a clean rewrite with matching step count and preserved digits', () => {
    expect(
      validateModeBOutput(source, {
        description: 'A spicy tofu curry with 200g of tofu.',
        steps: ['Sear the tofu.', 'Add 250ml coconut milk.', 'Simmer 15 minutes.'],
      }),
    ).toBe(true);
  });

  it('rejects when step count changes', () => {
    expect(
      validateModeBOutput(source, {
        description: 'Tofu curry.',
        steps: ['Sear the tofu.', 'Add coconut milk and simmer 15 minutes.'],
      }),
    ).toBe(false);
  });

  it('rejects invented digits', () => {
    expect(
      validateModeBOutput(source, {
        description: 'A spicy tofu curry with 200g of tofu.',
        // 300g and 12 minutes are invented numbers — should be rejected.
        steps: ['Sear the tofu for 12 minutes.', 'Add 300g of tofu and 250ml coconut milk.', 'Simmer 15 minutes.'],
      }),
    ).toBe(false);
  });

  it('rejects when old ingredient name still appears', () => {
    expect(
      validateModeBOutput(source, {
        description: 'A spicy tofu and chicken curry.',
        steps: ['Sear the chicken.', 'Add 250ml coconut milk.', 'Simmer 15 minutes.'],
      }),
    ).toBe(false);
  });

  it('rejects when new ingredient name is missing entirely', () => {
    expect(
      validateModeBOutput(source, {
        description: 'A spicy curry with vegetables.',
        steps: ['Sear it.', 'Add 250ml coconut milk.', 'Simmer 15 minutes.'],
      }),
    ).toBe(false);
  });

  it('rejects dramatic length blow-up', () => {
    const longStep = 'And then add a long winded explanation of the technique. '.repeat(40);
    expect(
      validateModeBOutput(source, {
        description: 'A spicy tofu curry. ' + longStep,
        steps: [longStep + 'Sear the tofu.', 'Add 250ml coconut milk.', 'Simmer 15 minutes.'],
      }),
    ).toBe(false);
  });
});

describe('rewriteSwapModeB', () => {
  const en: Locale = 'en';

  it('uses the AI output when the rewriter returns a slice', async () => {
    const out = await rewriteSwapModeB({
      source: new Map([
        [
          en,
          {
            title: 'Chicken curry',
            description: 'A spicy chicken curry.',
            steps: ['Sear the chicken until golden.', 'Add coconut milk.'],
          },
        ],
      ]),
      oldName: new Map([[en, 'chicken']]),
      newName: new Map([[en, 'tofu']]),
      rewrite: async () => ({
        description: 'A spicy tofu curry.',
        steps: ['Sear the tofu until crisp.', 'Add coconut milk.'],
      }),
    });
    expect(out.get(en)).toEqual({
      title: 'Chicken curry (with tofu)',
      description: 'A spicy tofu curry.',
      steps: ['Sear the tofu until crisp.', 'Add coconut milk.'],
    });
  });

  it('falls back to Mode A when the rewriter returns null', async () => {
    const out = await rewriteSwapModeB({
      source: new Map([
        [
          en,
          {
            title: 'Chicken curry',
            description: 'A spicy chicken curry.',
            steps: ['Sear the chicken.', 'Add coconut milk.'],
          },
        ],
      ]),
      oldName: new Map([[en, 'chicken']]),
      newName: new Map([[en, 'tofu']]),
      rewrite: async () => null,
    });
    expect(out.get(en)).toEqual({
      title: 'Chicken curry (with tofu)',
      description: 'A spicy tofu curry.',
      steps: ['Sear the tofu.', 'Add coconut milk.'],
    });
  });
});
